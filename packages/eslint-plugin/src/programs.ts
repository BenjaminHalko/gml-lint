/**
 * Shared Programs, one per GameMaker project, reused across files in an
 * ESLint run (and across runs in a long-lived ESLint server). Like
 * typescript-eslint's program cache.
 */

import { loadSpec, normalizePath, Program, type GmlSpec, type SourceFile } from "@gml-lint/checker";
import { loadProject, type Project } from "@gml-lint/project";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface GmlLanguageOptions {
  /**
   * Path to the .yyp (or its folder). Default: "auto" — the nearest .yyp above
   * the linted file. `false` lints files standalone (no project context).
   */
  project?: string | false;
  /** GmlSpec.xml to use instead of the bundled one. */
  spec?: string;
}

interface Entry {
  program: Program;
  /** mtimes of the .yyp when loaded, to notice resource changes */
  yypMtime: number;
}

const programs = new Map<string, Entry>();
const specs = new Map<string, GmlSpec>();
const yypForDir = new Map<string, string | null>();
let standalone: Program | null = null;

export function getSpec(options: GmlLanguageOptions): GmlSpec {
  const key = options.spec ?? "";
  let spec = specs.get(key);
  if (!spec) specs.set(key, (spec = loadSpec(options.spec)));
  return spec;
}

export function findYyp(fromFile: string): string | null {
  let dir = dirname(resolve(fromFile));
  const visited: string[] = [];
  while (true) {
    const cached = yypForDir.get(dir);
    if (cached !== undefined) {
      for (const v of visited) yypForDir.set(v, cached);
      return cached;
    }
    visited.push(dir);
    let found: string | null = null;
    try {
      const yyp = readdirSync(dir).find((n) => n.toLowerCase().endsWith(".yyp"));
      if (yyp) found = join(dir, yyp);
    } catch {
      // unreadable dir
    }
    if (found) {
      for (const v of visited) yypForDir.set(v, found);
      return found;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      for (const v of visited) yypForDir.set(v, null);
      return null;
    }
    dir = parent;
  }
}

function resolveYyp(options: GmlLanguageOptions, filename: string): string | null {
  if (options.project === false) return null;
  if (options.project && options.project !== "auto") {
    const p = resolve(options.project);
    if (p.toLowerCase().endsWith(".yyp")) return p;
    try {
      const yyp = readdirSync(p).find((n) => n.toLowerCase().endsWith(".yyp"));
      return yyp ? join(p, yyp) : null;
    } catch {
      return null;
    }
  }
  return findYyp(filename);
}

/** Gets the Program for a file and syncs the file's text into it. */
export function getProgramForFile(
  filename: string,
  text: string,
  options: GmlLanguageOptions,
): { program: Program; sourceFile: SourceFile; project: Project | null } {
  const spec = getSpec(options);
  const yyp = filename && existsSync(filename) ? resolveYyp(options, filename) : null;
  let program: Program;
  if (yyp) {
    const mtime = statSync(yyp).mtimeMs;
    let entry = programs.get(yyp);
    if (!entry || entry.yypMtime !== mtime || entry.program.spec !== spec) {
      entry = { program: new Program({ project: loadProject(yyp), spec }), yypMtime: mtime };
      programs.set(yyp, entry);
    }
    program = entry.program;
  } else {
    if (!standalone || standalone.spec !== spec) standalone = new Program({ spec });
    program = standalone;
  }
  const path = normalizePath(resolve(filename || "<input>.gml"));
  const existing = program.getSourceFile(path);
  const sourceFile = existing && existing.text === text ? existing : program.updateFile(path, text);
  return { program, sourceFile, project: program.project };
}

/** Drops cached programs (tests, editor reloads). */
export function clearPrograms(): void {
  programs.clear();
  yypForDir.clear();
  standalone = null;
}
