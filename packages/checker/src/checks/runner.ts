/**
 * Runs checks outside ESLint (tests, scripts). ESLint users get the same
 * checks as rules from eslint-plugin-gml.
 */

import type * as AST from "@gml-lint/parser";
import { childNodes } from "@gml-lint/parser";
import type { Program, SourceFile } from "../program.js";
import type { Check, CheckContext, Diagnostic, Edit, Visitor } from "./api.js";
import { Suppressions } from "./directives.js";

export const PARSE_ERROR_CODE = "GM1100";

export interface RunOptions {
  checks: readonly Check[];
  /** Restrict to these files (default: every program file). */
  files?: readonly SourceFile[];
  /** Options per check code or name. */
  options?: Record<string, Record<string, unknown>>;
}

/** Runs checks and returns their diagnostics, minus those suppressed by Feather directives. */
export function runChecks(program: Program, { checks, files, options = {} }: RunOptions): Diagnostic[] {
  const checker = program.getChecker();
  const suppressions = new Suppressions(program);
  const out: Diagnostic[] = [];
  for (const file of files ?? program.getSourceFiles()) {
    const sink: Diagnostic[] = [];
    const fc = checker.forFile(file);
    const visitors: Array<{ check: Check; visitor: Visitor }> = [];
    for (const check of checks) {
      if (check.meta.code === PARSE_ERROR_CODE) {
        for (const e of file.parseErrors) {
          sink.push({ code: check.meta.code, check: check.meta.name, message: e.message, file: file.path, range: e.range, loc: e.loc });
        }
        continue;
      }
      const opts = options[check.meta.code] ?? options[check.meta.name] ?? {};
      visitors.push({ check, visitor: check.create(makeContext(program, file, fc, check, opts, sink)) });
    }
    walk(file.ast, visitors);
    out.push(...suppressions.filter(file, sink));
  }
  return out.sort((a, b) => (a.file === b.file ? a.range[0] - b.range[0] : a.file < b.file ? -1 : 1));
}

export function makeContext(
  program: Program,
  file: SourceFile,
  fc: CheckContext["fc"],
  check: Check,
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
      const diagnostic: Diagnostic = {
        code: check.meta.code,
        check: check.meta.name,
        message: d.message,
        file: file.path,
        range: [range[0], range[1]],
        loc: file.lineMap.loc(range),
      };
      if (d.fix) diagnostic.fix = Array.isArray(d.fix) ? d.fix : [d.fix];
      if (d.suggestions) {
        diagnostic.suggestions = d.suggestions.map((s) => ({ message: s.message, edits: Array.isArray(s.edits) ? s.edits : [s.edits] }));
      }
      if (d.related) diagnostic.related = d.related;
      sink.push(diagnostic);
    },
  };
}

type Handler = (node: AST.Node, parent: AST.Node | null) => void;

function walk(root: AST.Program, visitors: Array<{ check: Check; visitor: Visitor }>): void {
  const enter = new Map<string, Handler[]>();
  const exit = new Map<string, Handler[]>();
  for (const { visitor } of visitors) {
    for (const [key, fn] of Object.entries(visitor)) {
      if (typeof fn !== "function") continue;
      const isExit = key.endsWith(":exit");
      const map = isExit ? exit : enter;
      const type = isExit ? key.slice(0, -5) : key;
      map.set(type, [...(map.get(type) ?? []), fn as Handler]);
    }
  }
  if (enter.size === 0 && exit.size === 0) return;
  const visit = (node: AST.Node, parent: AST.Node | null): void => {
    for (const fn of enter.get(node.type) ?? []) fn(node, parent);
    for (const child of childNodes(node)) visit(child, node);
    for (const fn of exit.get(node.type) ?? []) fn(node, parent);
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
  let applied = 0;
  let remaining = 0;
  for (const f of fixes) {
    if (f.start < cursor) {
      remaining++;
      continue;
    }
    for (const e of [...f.d.fix].sort((a, b) => a.range[0] - b.range[0])) {
      out += text.slice(cursor, e.range[0]) + e.text;
      cursor = e.range[1];
    }
    applied++;
  }
  out += text.slice(cursor);
  return { text: out, applied, remaining };
}
