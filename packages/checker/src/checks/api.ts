/**
 * Check API. A check is the gml-lint equivalent of an ESLint rule: metadata
 * plus a `create` function returning a visitor. The same checks run in the
 * `gmlc` CLI (via `runChecks`) and in eslint-plugin-gml (each check becomes an
 * ESLint rule), so visitor keys are node types exactly as in ESLint, with
 * optional `:exit` suffixes.
 */

import type * as AST from "@gml-lint/parser";
import type { Checker, FileChecker } from "../checker.js";
import type { Program, SourceFile } from "../program.js";

export type Severity = "error" | "warning" | "suggestion";
export type SeveritySetting = Severity | "off";
export type CheckCategory = "syntax" | "semantic" | "type" | "state" | "style";

/**
 * Presets, mirroring Feather's profiles:
 *  - syntax:      things the GameMaker compiler rejects
 *  - recommended: Feather's "All" profile without Strict Type mode
 *  - strict:      recommended + Strict Type mode rules
 *  - all:         everything, including opinionated style rules (naming)
 */
export type Preset = "syntax" | "recommended" | "strict" | "all";

export interface Edit {
  range: AST.Range;
  text: string;
}

export interface RelatedLocation {
  message: string;
  file: string;
  range: AST.Range;
}

export interface Diagnostic {
  /** Feather code (GM1013) or gml-lint code (GT0001). */
  code: string;
  /** Kebab-case check name. */
  check: string;
  message: string;
  severity: Severity;
  /** Absolute path of the file. */
  file: string;
  range: AST.Range;
  loc: AST.SourceLocation;
  /** Automatic fix (applied by --fix): non-overlapping edits. */
  fix?: Edit[];
  /** Alternative manual fixes (editor quick fixes). */
  suggestions?: Array<{ message: string; edits: Edit[] }>;
  related?: RelatedLocation[];
}

export interface CheckMeta {
  /** Feather code (GMxxxx) or gml-lint code (GTxxxx). */
  code: string;
  /** Kebab-case name, used as the ESLint rule name. */
  name: string;
  /** One-line description (Feather's message title for GM rules). */
  description: string;
  category: CheckCategory;
  defaultSeverity: Severity;
  /** Lowest preset that enables the check (higher presets include lower ones). */
  preset: Preset;
  /** Implements a documented Feather rule. */
  feather: boolean;
  /** Has an automatic fix. */
  fixable?: boolean;
  /** Documentation URL. */
  docs?: string;
}

export interface ReportDescriptor {
  /** Node to report; `range` overrides it. */
  node?: AST.Node | { range: AST.Range };
  range?: AST.Range;
  message: string;
  fix?: Edit | Edit[];
  suggestions?: Array<{ message: string; edits: Edit | Edit[] }>;
  related?: RelatedLocation[];
}

export interface CheckContext {
  readonly file: SourceFile;
  readonly program: Program;
  readonly checker: Checker;
  /** Per-file queries: resolution, types, scopes, parents. */
  readonly fc: FileChecker;
  /** Options from configuration (`rules: { GM2017: ["warning", {...}] }`). */
  readonly options: Readonly<Record<string, unknown>>;
  /** Source text of a node or range. */
  getText(node: AST.Node | AST.Range): string;
  report(descriptor: ReportDescriptor): void;
}

type VisitorFn<T> = (node: T, parent: AST.Node | null) => void;

/** ESLint-style visitor keyed by node type (and `Type:exit`). */
export type Visitor = {
  [K in AST.NodeType]?: VisitorFn<AST.NodeOfType<K>>;
} & {
  [K in AST.NodeType as `${K}:exit`]?: VisitorFn<AST.NodeOfType<K>>;
};

export interface Check {
  meta: CheckMeta;
  create(context: CheckContext): Visitor;
}

export const FEATHER_DOCS = "https://manual.gamemaker.io/monthly/en/The_Asset_Editors/Code_Editor_Properties/Feather_Messages.htm";

/** Helper so check modules get type inference on their visitor. */
export function defineCheck(check: Check): Check {
  return check;
}
