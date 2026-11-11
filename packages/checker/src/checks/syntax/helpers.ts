/** AST helpers for the syntax checks (`docs` and `statementList` are also used by the semantic checks). */

import type * as AST from "@gml-lint/parser";
import { childNodes } from "@gml-lint/parser";
import { FEATHER_DOCS } from "../api.js";
import type { SourceFile } from "../../program.js";

export const docs = (code: string) => `${FEATHER_DOCS}#:~:text=${code}`;

/** The statement list a node holds, if it is a list container. */
export function statementList(node: AST.Node): AST.Statement[] | null {
  switch (node.type) {
    case "Program":
    case "BlockStatement":
      return node.body;
    case "SwitchCase":
      return node.consequent;
    default:
      return null;
  }
}

export function isDirective(s: AST.Node): boolean {
  return s.type === "MacroDeclaration" || s.type === "RegionDirective" || s.type === "DefineDirective";
}

/** `a`, `a.b`, `a.b.c`: side-effect free and comparable by text. */
export function isPlainChain(e: AST.Expression): boolean {
  if (e.type === "Identifier") return true;
  if (e.type === "MemberExpression") return isPlainChain(e.object);
  return false;
}

/** Root identifier of a member chain. */
export function chainRoot(e: AST.Expression): AST.Identifier | null {
  while (e.type === "MemberExpression") e = e.object;
  return e.type === "Identifier" ? e : null;
}

export function isNumberLiteral(e: AST.Node): e is AST.Literal {
  return e.type === "Literal" && (e.kind === "real" || e.kind === "hex" || e.kind === "binary" || e.kind === "colour");
}

export function isStringLiteral(e: AST.Node): e is AST.Literal {
  return e.type === "Literal" && (e.kind === "string" || e.kind === "verbatim");
}

/** Source text with whitespace removed, for structural comparisons. */
export function compact(text: string): string {
  return text.replace(/\s+/g, "");
}

/** Every Identifier named `name` under `root` (including nested functions). */
export function identifiersNamed(root: AST.Node, name: string, out: AST.Identifier[] = []): AST.Identifier[] {
  if (root.type === "Identifier") {
    if (root.name === name) out.push(root);
    return out;
  }
  for (const c of childNodes(root)) identifiersNamed(c, name, out);
  return out;
}

/** Names of every Identifier under `root`. */
export function identifierNames(root: AST.Node, out: Set<string> = new Set()): Set<string> {
  if (root.type === "Identifier") {
    out.add(root.name);
    return out;
  }
  for (const c of childNodes(root)) identifierNames(c, out);
  return out;
}

/** Whether any comment lies inside the range. */
export function hasCommentIn(file: SourceFile, range: AST.Range): boolean {
  for (const c of file.ast.comments) {
    if (c.range[0] >= range[0] && c.range[1] <= range[1]) return true;
    if (c.range[0] >= range[1]) break;
  }
  return false;
}

/** Orders declarations deterministically: by file path, then offset. */
export function byLocation<T extends { node: AST.Node; file: SourceFile }>(a: T, b: T): number {
  if (a.file.path !== b.file.path) return a.file.path < b.file.path ? -1 : 1;
  return a.node.range[0] - b.node.range[0];
}
