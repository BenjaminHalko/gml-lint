/**
 * Suppression comments.
 *
 * gml-lint (ESLint-style):
 *   // gmlint-disable [codes]            until gmlint-enable / end of file
 *   // gmlint-enable [codes]
 *   // gmlint-disable-next-line [codes]
 *   // gmlint-disable-line [codes]       (trailing comment)
 *
 * Feather (https://manual.gamemaker.io/.../Feather_Directives.htm):
 *   // Feather ignore|disable [once] GM1010[, GM...]|all [in PATH]
 *   // Feather restore|enable GM1010|all [in PATH]
 *   // Feather use none|syntax-errors|type-errors|all [in PATH]
 * Directives apply from the comment onwards, to the end of the file. With
 * `in PATH` they apply to other assets, matched against Asset Browser paths:
 * `*` (everything), `/Scripts/*`, `./*` (this folder), `/Foo/obj_bar`.
 *
 * Codes may be given as GM codes or check names.
 */

import type { Program, SourceFile } from "../program.js";
import type { Diagnostic, Preset } from "./api.js";
import { presetIncludes } from "./config.js";
import { globToRegExp } from "./glob.js";

type CodeSet = "all" | Set<string>;

interface Event {
  offset: number;
  action: "disable" | "enable" | "once" | "profile";
  codes: CodeSet;
  profile?: Preset | "none";
}

interface LineRule {
  line: number;
  codes: CodeSet;
}

interface FileDirectives {
  events: Event[];
  lines: LineRule[];
}

interface PathDirective {
  /** Asset browser path pattern, already resolved against the declaring file's folder. */
  pattern: RegExp;
  event: Omit<Event, "offset">;
}

const GMLINT_RE = /^\s*gmlint-(disable-next-line|disable-line|disable|enable)\b(.*)$/s;
const FEATHER_RE = /^\s*feather\s+(ignore|disable|restore|enable|use)\b(.*)$/is;

function parseCodes(text: string): CodeSet {
  const cleaned = text.replace(/--.*$/s, "").trim(); // allow `-- reason`
  if (!cleaned || /^all\b/i.test(cleaned)) return "all";
  const codes = new Set<string>();
  for (const part of cleaned.split(/[\s,]+/)) if (part) codes.add(part.replace(/^gml\//, "").toUpperCase());
  return codes;
}

function profileOf(text: string): Preset | "none" | null {
  const t = text.trim().toLowerCase();
  if (t.startsWith("none")) return "none";
  if (t.startsWith("syntax")) return "syntax";
  if (t.startsWith("type")) return "strict";
  if (t.startsWith("all")) return "all";
  return null;
}

function splitIn(rest: string): { body: string; path: string | null } {
  const m = /^(.*?)\s+in\s+(\S+)\s*$/is.exec(rest);
  return m ? { body: m[1]!, path: m[2]! } : { body: rest, path: null };
}

function parseFile(file: SourceFile, featherEnabled: boolean, pathDirectives: PathDirective[], folderOf: (f: SourceFile) => string | null): FileDirectives {
  const events: Event[] = [];
  const lines: LineRule[] = [];
  for (const c of file.ast.comments) {
    const value = c.type === "Line" ? c.value.replace(/^\/+/, "") : c.value;
    const g = GMLINT_RE.exec(value);
    if (g) {
      const codes = parseCodes(g[2] ?? "");
      switch (g[1]) {
        case "disable":
          events.push({ offset: c.range[0], action: "disable", codes });
          break;
        case "enable":
          events.push({ offset: c.range[0], action: "enable", codes });
          break;
        case "disable-next-line":
          lines.push({ line: c.loc.end.line + 1, codes });
          break;
        case "disable-line":
          lines.push({ line: c.loc.start.line, codes });
          break;
      }
      continue;
    }
    if (!featherEnabled) continue;
    const f = FEATHER_RE.exec(value);
    if (!f) continue;
    const verb = f[1]!.toLowerCase();
    const { body, path } = splitIn(f[2] ?? "");
    let event: Omit<Event, "offset"> | null = null;
    if (verb === "ignore" || verb === "disable") {
      const once = /^\s*once\b/i.test(body);
      event = { action: once ? "once" : "disable", codes: parseCodes(once ? body.replace(/^\s*once\b/i, "") : body) };
    } else if (verb === "restore" || verb === "enable") {
      event = { action: "enable", codes: parseCodes(body) };
    } else if (verb === "use") {
      const profile = profileOf(body);
      if (profile) event = { action: "profile", codes: "all", profile };
    }
    if (!event) continue;
    if (path) {
      pathDirectives.push({ pattern: assetPathPattern(path, folderOf(file)), event });
    } else {
      events.push({ offset: c.range[0], ...event });
    }
  }
  return { events, lines };
}

function assetPathPattern(path: string, currentFolder: string | null): RegExp {
  let p = path.trim();
  if (p === "*") return /.*/;
  if (p.startsWith("./")) p = (currentFolder ? currentFolder + "/" : "") + p.slice(2);
  else if (p.startsWith("/")) p = p.slice(1);
  // `Folder/*` matches everything below Folder
  if (p.endsWith("/*")) p = p.slice(0, -2) + "/**";
  return globToRegExp(p);
}

function codeMatches(set: CodeSet, d: Diagnostic): boolean {
  return set === "all" || set.has(d.code.toUpperCase()) || set.has(d.check.toUpperCase());
}

export interface SuppressionOptions {
  featherDirectives?: boolean;
  /** Lowest preset that enables a code, for `// Feather use <profile>`. */
  presetOf?: (code: string) => Preset | null;
}

/**
 * Builds a filter that removes suppressed diagnostics. Diagnostics must be
 * passed per file; `once` directives consume the first matching diagnostic.
 */
export class Suppressions {
  /** Per-file directives, keyed by SourceFile object so updated files are re-read. */
  private readonly perFile = new WeakMap<SourceFile, FileDirectives>();
  private readonly pathDirectives: PathDirective[] = [];
  private readonly program: Program;
  private readonly options: SuppressionOptions;
  private readonly feather: boolean;

  constructor(program: Program, options: SuppressionOptions = {}) {
    this.program = program;
    this.options = options;
    this.feather = options.featherDirectives ?? true;
    // `in PATH` directives can come from any file, so scan everything once.
    for (const f of program.getSourceFiles()) {
      this.perFile.set(f, parseFile(f, this.feather, this.pathDirectives, (sf) => this.folderPath(sf, false)));
    }
  }

  private directivesOf(file: SourceFile): FileDirectives {
    let fd = this.perFile.get(file);
    if (!fd) {
      fd = parseFile(file, this.feather, [], (sf) => this.folderPath(sf, false));
      this.perFile.set(file, fd);
    }
    return fd;
  }

  /** Asset browser path of a file's owning resource, e.g. "Scripts/Libraries/Input/InputCheck". */
  private folderPath(file: SourceFile, includeName = true): string | null {
    const owner = file.gml?.owner;
    if (!owner) return null;
    const res = this.program.project?.resources.get(owner);
    const folder = res?.folder ?? "";
    return includeName ? (folder ? folder + "/" : "") + owner : folder || null;
  }

  filter(file: SourceFile, diagnostics: Diagnostic[]): Diagnostic[] {
    const fd = this.directivesOf(file);
    const assetPath = this.folderPath(file);
    const initial: Event[] = assetPath
      ? this.pathDirectives.filter((p) => p.pattern.test(assetPath)).map((p) => ({ offset: -1, ...p.event }))
      : [];
    const events = [...initial, ...fd.events].sort((a, b) => a.offset - b.offset);
    const sorted = [...diagnostics].sort((a, b) => a.range[0] - b.range[0]);
    const onceUsed = new Set<Event>();
    const out: Diagnostic[] = [];
    for (const d of sorted) {
      if (fd.lines.some((l) => l.line === d.loc.start.line && codeMatches(l.codes, d))) continue;
      let suppressed = false;
      for (const e of events) {
        if (e.offset > d.range[0]) break;
        switch (e.action) {
          case "disable":
            if (codeMatches(e.codes, d)) suppressed = true;
            break;
          case "enable":
            if (codeMatches(e.codes, d)) suppressed = false;
            break;
          case "profile": {
            const preset = this.options.presetOf?.(d.code) ?? null;
            if (e.profile === "none") suppressed = true;
            else if (preset && e.profile) suppressed = !presetIncludes(e.profile, preset);
            else suppressed = false;
            break;
          }
          case "once":
            break;
        }
      }
      if (!suppressed) {
        const once = events.find((e) => e.action === "once" && e.offset <= d.range[0] && !onceUsed.has(e) && codeMatches(e.codes, d));
        if (once) {
          onceUsed.add(once);
          suppressed = true;
        }
      }
      if (!suppressed) out.push(d);
    }
    return out;
  }
}
