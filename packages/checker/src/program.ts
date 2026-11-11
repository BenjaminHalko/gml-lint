/**
 * A Program is the set of source files the checker reasons about, plus the
 * project model and the built-in API. `updateFile` swaps one file and drops
 * cached analysis.
 */

import { parse, type LineMap, type ParseError, type Program as AST_Program } from "@gml-lint/parser";
import type { GmlFile, Project } from "@gml-lint/project";
import type { GmlSpec } from "./spec/index.js";
import { readFileSync } from "node:fs";
import { Checker } from "./checker.js";
import { collectDocComments, type DocComment } from "./jsdoc.js";

export interface SourceFile {
  /** Absolute path with forward slashes (or a virtual path for in-memory files). */
  path: string;
  text: string;
  /** Project information about this file, when it belongs to a project. */
  gml: GmlFile | null;
  ast: AST_Program;
  parseErrors: ParseError[];
  lineMap: LineMap;
  docs: DocComment[];
  /** Increments on every update. */
  version: number;
}

export interface ProgramOptions {
  project?: Project | null;
  spec?: GmlSpec | null;
  /** Read file contents (defaults to fs). Return undefined to skip a file. */
  readFile?: (path: string) => string | undefined;
  /** Additional/override in-memory files: path -> text. */
  files?: Iterable<[path: string, text: string]>;
  /**
   * Include event files that the object's .yy does not list (GameMaker never
   * runs them). Default: true, so they are still checked.
   */
  includeUnlistedEvents?: boolean;
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export class Program {
  readonly project: Project | null;
  readonly spec: GmlSpec | null;
  private readonly files = new Map<string, SourceFile>();
  private checker: Checker | null = null;

  constructor(options: ProgramOptions = {}) {
    this.project = options.project ?? null;
    this.spec = options.spec ?? null;
    const read = options.readFile ?? defaultRead;
    const overrides = new Map<string, string>();
    for (const [p, t] of options.files ?? []) overrides.set(normalizePath(p), t);

    if (this.project) {
      for (const gml of this.project.gmlFiles) {
        if (gml.listed === false && options.includeUnlistedEvents === false) continue;
        const path = normalizePath(gml.path);
        const text = overrides.get(path) ?? read(path);
        if (text === undefined) continue;
        this.files.set(path, makeSourceFile(path, text, gml, 0));
      }
    }
    for (const [path, text] of overrides) {
      if (!this.files.has(path)) this.files.set(path, makeSourceFile(path, text, this.findGmlFile(path), 0));
    }
  }

  getSourceFiles(): SourceFile[] {
    return [...this.files.values()];
  }

  getSourceFile(path: string): SourceFile | undefined {
    return this.files.get(normalizePath(path));
  }

  /** Adds or replaces a file's text. Returns the new SourceFile. */
  updateFile(path: string, text: string): SourceFile {
    const p = normalizePath(path);
    const old = this.files.get(p);
    if (old && old.text === text) return old;
    const file = makeSourceFile(p, text, old?.gml ?? this.findGmlFile(p), (old?.version ?? 0) + 1);
    this.files.set(p, file);
    this.checker = null;
    return file;
  }

  removeFile(path: string): void {
    if (this.files.delete(normalizePath(path))) this.checker = null;
  }

  getChecker(): Checker {
    this.checker ??= new Checker(this);
    return this.checker;
  }

  /** `path` must already be normalized. */
  private findGmlFile(path: string): GmlFile | null {
    if (!this.project) return null;
    const p = path.toLowerCase();
    return this.project.gmlFiles.find((g) => normalizePath(g.path).toLowerCase() === p) ?? null;
  }
}

function defaultRead(path: string): string | undefined {
  try {
    const text = readFileSync(path, "utf8");
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return undefined;
  }
}

export function makeSourceFile(path: string, text: string, gml: GmlFile | null, version: number): SourceFile {
  const r = parse(text);
  return {
    path,
    text,
    gml,
    ast: r.ast,
    parseErrors: r.errors,
    lineMap: r.lineMap,
    docs: collectDocComments(r.ast, text),
    version,
  };
}
