/** Helpers shared by checks. */

import type * as AST from "@gml-lint/parser";
import type { FileChecker } from "../checker.js";

export function isFunctionNode(n: AST.Node): n is AST.FunctionLike {
  return n.type === "FunctionDeclaration" || n.type === "FunctionExpression";
}

export function isLoopNode(n: AST.Node): n is AST.LoopStatement {
  return (
    n.type === "WhileStatement" ||
    n.type === "DoUntilStatement" ||
    n.type === "RepeatStatement" ||
    n.type === "ForStatement" ||
    n.type === "WithStatement"
  );
}

/** Strips parentheses. */
export function unparen(e: AST.Expression): AST.Expression {
  while (e.type === "ParenthesizedExpression") e = e.expression;
  return e;
}

/** Name of a call's callee when it is a plain identifier. */
export function calleeName(call: AST.CallExpression | AST.NewExpression): string | null {
  const c = unparen(call.callee);
  return c.type === "Identifier" ? c.name : null;
}

/** The innermost function node (or Program) containing `node`. */
export function enclosingFunction(fc: FileChecker, node: AST.Node): AST.FunctionLike | AST.Program {
  for (const a of fc.ancestors(node)) {
    if (isFunctionNode(a) || a.type === "Program") return a;
  }
  return fc.file.ast;
}

/** Whether `node` is used as a statement on its own (its value discarded). */
export function isDiscarded(fc: FileChecker, node: AST.Expression): boolean {
  let cur: AST.Node = node;
  let parent = fc.parent(cur);
  while (parent?.type === "ParenthesizedExpression") {
    cur = parent;
    parent = fc.parent(cur);
  }
  return parent?.type === "ExpressionStatement" && parent.expression === cur;
}

/** `1 argument`, `2 arguments`. */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
