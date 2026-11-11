import type * as AST from "@gml-lint/parser";
import { childNodes } from "@gml-lint/parser";
import type { Program, SourceFile } from "../program.js";
import type { Check, CheckContext, Diagnostic, Edit, Preset, Severity, Visitor } from "./api.js";
import { enabledChecks, matchesFile, type FileIdentity, type GmlintConfig } from "./config.js";
import { Suppressions } from "./directives.js";

export interface RunOptions {
  checks: readonly Check[];
  config?: GmlintConfig;
  /** Restrict to these files (default: all program files). */
  files?: readonly SourceFile[];
  /** Called when a check throws; default records an internal-error diagnostic. */
  onCheckError?: (check: Check, file: SourceFile, error: unknown) => void;
}

export interface RunResult {
  diagnostics: Diagnostic[];
  filesChecked: number;
  filesIgnored: number;
  /** Milliseconds spent per check code. */
  timings: Map<string, number>;
}

export const PARSE_ERROR_CODE = "GM1100";

export function fileIdentity(program: Program, file: SourceFile): FileIdentity {
  const rel = file.gml?.relativePath ?? file.path;
  const owner = file.gml?.owner ?? null;
  const res = owner ? program.project?.resources.get(owner) : undefined;
  const folderPath = owner ? `${res?.folder ? res.folder + "/" : ""}${owner}` : null;
  return { relativePath: rel, folderPath };
}

export function runChecks(program: Program, options: RunOptions): RunResult {
  const config = options.config ?? {};
  const checker = program.getChecker();
  const presetByCode = new Map<string, Preset>(options.checks.map((c) => [c.meta.code, c.meta.preset]));
  const suppressions = new Suppressions(program, {
    featherDirectives: config.featherDirectives ?? true,
    presetOf: (code) => presetByCode.get(code) ?? null,
  });
  const timings = new Map<string, number>();
  const diagnostics: Diagnostic[] = [];
  let filesChecked = 0;
  let filesIgnored = 0;

  for (const file of options.files ?? program.getSourceFiles()) {
    const id = fileIdentity(program, file);
    if (matchesFile(config.ignore, id)) {
      filesIgnored++;
      continue;
    }
    filesChecked++;
    const fileDiagnostics: Diagnostic[] = [];
    const enabled = enabledChecks(options.checks, config, id);
    const parseCheck = enabled.find((e) => e.check.meta.code === PARSE_ERROR_CODE);
    if (parseCheck) {
      for (const e of file.parseErrors) {
        fileDiagnostics.push({
          code: PARSE_ERROR_CODE,
          check: parseCheck.check.meta.name,
          message: e.message,
          severity: parseCheck.severity,
          file: file.path,
          range: e.range,
          loc: e.loc,
        });
      }
    }
    const fc = checker.forFile(file);
    const visitors: Array<{ check: Check; visitor: Visitor }> = [];
    for (const { check, severity, options: checkOptions } of enabled) {
      if (check.meta.code === PARSE_ERROR_CODE) continue;
      const context = makeContext(program, file, fc, check, severity, checkOptions, fileDiagnostics);
      try {
        visitors.push({ check, visitor: check.create(context) });
      } catch (err) {
        reportCrash(options, check, file, err, fileDiagnostics);
      }
    }
    walk(file.ast, visitors, timings, (check, err) => reportCrash(options, check, file, err, fileDiagnostics));
    diagnostics.push(...suppressions.filter(file, fileDiagnostics));
  }
  diagnostics.sort((a, b) => (a.file === b.file ? a.range[0] - b.range[0] : a.file < b.file ? -1 : 1));
  return { diagnostics, filesChecked, filesIgnored, timings };
}

function reportCrash(options: RunOptions, check: Check, file: SourceFile, err: unknown, out: Diagnostic[]): void {
  if (options.onCheckError) {
    options.onCheckError(check, file, err);
    return;
  }
  out.push({
    code: "GT9999",
    check: "internal-error",
    message: `Check ${check.meta.code} (${check.meta.name}) crashed: ${(err as Error)?.message ?? String(err)}`,
    severity: "error",
    file: file.path,
    range: [0, 0],
    loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
  });
}

export function makeContext(
  program: Program,
  file: SourceFile,
  fc: CheckContext["fc"],
  check: Check,
  severity: Severity,
  options: Record<string, unknown>,
  sink: Diagnostic[],
): CheckContext {
  return {
    file,
    program,
    checker: fc.checker,
    fc,
    options,
    getText(node: AST.Node | AST.Range): string {
      const r = Array.isArray(node) ? node : node.range;
      return file.text.slice(r[0], r[1]);
    },
    report(d) {
      const range = d.range ?? d.node?.range ?? [0, 0];
      const fix = d.fix ? (Array.isArray(d.fix) ? d.fix : [d.fix]) : undefined;
      const diagnostic: Diagnostic = {
        code: check.meta.code,
        check: check.meta.name,
        message: d.message,
        severity,
        file: file.path,
        range: [range[0], range[1]],
        loc: file.lineMap.loc(range),
      };
      if (fix) diagnostic.fix = fix;
      if (d.suggestions) {
        diagnostic.suggestions = d.suggestions.map((s) => ({ message: s.message, edits: Array.isArray(s.edits) ? s.edits : [s.edits] }));
      }
      if (d.related) diagnostic.related = d.related;
      sink.push(diagnostic);
    },
  };
}

type Handler = (node: AST.Node, parent: AST.Node | null) => void;

function walk(
  root: AST.Program,
  visitors: Array<{ check: Check; visitor: Visitor }>,
  timings: Map<string, number>,
  onError: (check: Check, err: unknown) => void,
): void {
  const enter = new Map<string, Array<{ check: Check; fn: Handler }>>();
  const exit = new Map<string, Array<{ check: Check; fn: Handler }>>();
  for (const { check, visitor } of visitors) {
    for (const [key, fn] of Object.entries(visitor)) {
      if (typeof fn !== "function") continue;
      const isExit = key.endsWith(":exit");
      const type = isExit ? key.slice(0, -5) : key;
      const map = isExit ? exit : enter;
      let list = map.get(type);
      if (!list) map.set(type, (list = []));
      list.push({ check, fn: fn as Handler });
    }
  }
  if (enter.size === 0 && exit.size === 0) return;
  const call = (list: Array<{ check: Check; fn: Handler }> | undefined, node: AST.Node, parent: AST.Node | null): void => {
    if (!list) return;
    for (const { check, fn } of list) {
      const t0 = performance.now();
      try {
        fn(node, parent);
      } catch (err) {
        onError(check, err);
      }
      timings.set(check.meta.code, (timings.get(check.meta.code) ?? 0) + performance.now() - t0);
    }
  };
  const visit = (node: AST.Node, parent: AST.Node | null): void => {
    call(enter.get(node.type), node, parent);
    for (const child of childNodes(node)) visit(child, node);
    call(exit.get(node.type), node, parent);
  };
  visit(root, null);
}

/**
 * Applies non-overlapping fixes (ESLint semantics: sorted by position, a fix
 * overlapping an earlier one is skipped and left for another pass).
 */
export function applyFixes(text: string, diagnostics: readonly Diagnostic[]): { text: string; applied: number; remaining: number } {
  const fixes = diagnostics
    .filter((d): d is Diagnostic & { fix: Edit[] } => !!d.fix && d.fix.length > 0)
    .map((d) => ({ d, start: Math.min(...d.fix.map((e) => e.range[0])), end: Math.max(...d.fix.map((e) => e.range[1])) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let cursor = 0;
  let lastEnd = -1;
  let applied = 0;
  let remaining = 0;
  for (const f of fixes) {
    if (f.start < lastEnd || f.start < cursor) {
      remaining++;
      continue;
    }
    const edits = [...f.d.fix].sort((a, b) => a.range[0] - b.range[0]);
    for (const e of edits) {
      out += text.slice(cursor, e.range[0]) + e.text;
      cursor = e.range[1];
    }
    lastEnd = f.end;
    applied++;
  }
  out += text.slice(cursor);
  return { text: out, applied, remaining };
}
