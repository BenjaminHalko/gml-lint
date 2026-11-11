import type { Diagnostic, Severity } from "@gml-lint/checker";
import { relative } from "node:path";

export interface FormatContext {
  projectDir: string;
  projectName: string | null;
  toolVersion: string;
  filesChecked: number;
  color: boolean;
}

export type Formatter = (diagnostics: readonly Diagnostic[], ctx: FormatContext) => string;

export function relPath(ctx: FormatContext, file: string): string {
  return relative(ctx.projectDir, file).replace(/\\/g, "/") || file;
}

export function summarize(diagnostics: readonly Diagnostic[]): Record<Severity, number> {
  const s: Record<Severity, number> = { error: 0, warning: 0, suggestion: 0 };
  for (const d of diagnostics) s[d.severity]++;
  return s;
}

const ansi = (code: string) => (s: string, on: boolean) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = ansi("31");
const yellow = ansi("33");
const cyan = ansi("36");
const dim = ansi("2");
const bold = ansi("1");
const underline = ansi("4");

function severityLabel(s: Severity, color: boolean): string {
  switch (s) {
    case "error":
      return red("error", color);
    case "warning":
      return yellow("warning", color);
    default:
      return cyan("suggestion", color);
  }
}

/** ESLint "stylish"-like output grouped by file. */
export const pretty: Formatter = (diagnostics, ctx) => {
  const byFile = new Map<string, Diagnostic[]>();
  for (const d of diagnostics) {
    let list = byFile.get(d.file);
    if (!list) byFile.set(d.file, (list = []));
    list.push(d);
  }
  const out: string[] = [];
  for (const [file, list] of byFile) {
    out.push("", underline(relPath(ctx, file), ctx.color));
    const posWidth = Math.max(...list.map((d) => `${d.loc.start.line}:${d.loc.start.column + 1}`.length));
    for (const d of list) {
      const pos = `${d.loc.start.line}:${d.loc.start.column + 1}`.padEnd(posWidth);
      const sev = severityLabel(d.severity, ctx.color);
      const pad = " ".repeat(Math.max(0, 10 - d.severity.length));
      out.push(`  ${dim(pos, ctx.color)}  ${sev}${pad}  ${d.message}  ${dim(`${d.code} ${d.check}`, ctx.color)}`);
    }
  }
  const s = summarize(diagnostics);
  const total = s.error + s.warning + s.suggestion;
  out.push("");
  if (total === 0) {
    out.push(`No problems found in ${ctx.filesChecked} files.`);
  } else {
    const parts = [`${s.error} error${s.error === 1 ? "" : "s"}`, `${s.warning} warning${s.warning === 1 ? "" : "s"}`];
    if (s.suggestion) parts.push(`${s.suggestion} suggestion${s.suggestion === 1 ? "" : "s"}`);
    const fixable = diagnostics.filter((d) => d.fix).length;
    const line = `${total} problem${total === 1 ? "" : "s"} (${parts.join(", ")}) in ${ctx.filesChecked} files`;
    out.push(bold(s.error ? red(line, ctx.color) : yellow(line, ctx.color), ctx.color));
    if (fixable) out.push(dim(`  ${fixable} fixable with --fix`, ctx.color));
  }
  return out.join("\n") + "\n";
};

/** One line per diagnostic: path:line:col: severity message [code]. */
export const compact: Formatter = (diagnostics, ctx) =>
  diagnostics
    .map((d) => `${relPath(ctx, d.file)}:${d.loc.start.line}:${d.loc.start.column + 1}: ${d.severity} ${d.message} [${d.code}]`)
    .join("\n") + (diagnostics.length ? "\n" : "");

/**
 * Stable machine-readable output (schema version 1), the contract for
 * editor/IDE integrations. Lines and columns are 1-based; `range` holds
 * 0-based UTF-16 offsets.
 */
export const json: Formatter = (diagnostics, ctx) => {
  const s = summarize(diagnostics);
  const doc = {
    schemaVersion: 1,
    tool: { name: "gmlc", version: ctx.toolVersion },
    project: { name: ctx.projectName, path: ctx.projectDir.replace(/\\/g, "/") },
    summary: { files: ctx.filesChecked, errors: s.error, warnings: s.warning, suggestions: s.suggestion },
    diagnostics: diagnostics.map((d) => ({
      code: d.code,
      check: d.check,
      severity: d.severity,
      message: d.message,
      file: relPath(ctx, d.file),
      startLine: d.loc.start.line,
      startColumn: d.loc.start.column + 1,
      endLine: d.loc.end.line,
      endColumn: d.loc.end.column + 1,
      range: d.range,
      ...(d.fix ? { fix: d.fix } : {}),
      ...(d.suggestions ? { suggestions: d.suggestions } : {}),
      ...(d.related ? { related: d.related.map((r) => ({ ...r, file: relPath(ctx, r.file) })) } : {}),
    })),
  };
  return JSON.stringify(doc, null, 2) + "\n";
};

/** GitHub Actions workflow commands (annotations on pull requests). */
export const github: Formatter = (diagnostics, ctx) =>
  diagnostics
    .map((d) => {
      const level = d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "notice";
      const props = [
        `file=${relPath(ctx, d.file)}`,
        `line=${d.loc.start.line}`,
        `col=${d.loc.start.column + 1}`,
        `endLine=${d.loc.end.line}`,
        `endColumn=${d.loc.end.column + 1}`,
        `title=${d.code} ${d.check}`,
      ].join(",");
      return `::${level} ${props}::${escapeGithub(d.message)}`;
    })
    .join("\n") + (diagnostics.length ? "\n" : "");

function escapeGithub(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export const formatters: Readonly<Record<string, Formatter>> = { pretty, compact, json, github };
