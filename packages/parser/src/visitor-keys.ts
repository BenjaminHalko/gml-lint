import type { Node, NodeType } from "./ast.js";

/**
 * Child keys per node type, in source order. Used by `traverse` and by ESLint.
 * `MacroDeclaration.expression` is not visited: the macro body is not code at
 * the position it is declared.
 */
export const visitorKeys: Readonly<Record<NodeType, readonly string[]>> = {
  Program: ["body"],
  BlockStatement: ["body"],
  EmptyStatement: [],
  ExpressionStatement: ["expression"],
  VariableDeclaration: ["declarations"],
  VariableDeclarator: ["id", "init"],
  IfStatement: ["test", "consequent", "alternate"],
  WhileStatement: ["test", "body"],
  DoUntilStatement: ["body", "test"],
  RepeatStatement: ["count", "body"],
  ForStatement: ["init", "test", "update", "body"],
  WithStatement: ["object", "body"],
  SwitchStatement: ["discriminant", "cases"],
  SwitchCase: ["test", "consequent"],
  BreakStatement: [],
  ContinueStatement: [],
  ExitStatement: [],
  ReturnStatement: ["argument"],
  ThrowStatement: ["argument"],
  TryStatement: ["block", "handler", "finalizer"],
  CatchClause: ["param", "body"],
  DeleteStatement: ["argument"],
  EnumDeclaration: ["id", "members"],
  EnumMember: ["id", "initializer"],
  FunctionDeclaration: ["id", "params", "parent", "body"],
  FunctionExpression: ["id", "params", "parent", "body"],
  Parameter: ["id", "init"],
  ConstructorParent: ["callee", "arguments"],
  MacroDeclaration: ["config", "id"],
  RegionDirective: [],
  DefineDirective: [],
  InvalidStatement: [],
  Identifier: [],
  Literal: [],
  TemplateLiteral: ["quasis", "expressions"],
  TemplateElement: [],
  ArrayExpression: ["elements"],
  StructExpression: ["properties"],
  StructProperty: ["key", "value"],
  ParenthesizedExpression: ["expression"],
  UnaryExpression: ["argument"],
  UpdateExpression: ["argument"],
  BinaryExpression: ["left", "right"],
  LogicalExpression: ["left", "right"],
  ConditionalExpression: ["test", "consequent", "alternate"],
  CallExpression: ["callee", "arguments"],
  NewExpression: ["callee", "arguments"],
  MemberExpression: ["object", "property"],
  IndexExpression: ["object", "indices"],
  InvalidExpression: [],
  AssignmentExpression: ["left", "right"],
};

/** Direct children of a node, in source order. */
export function childNodes(node: Node): Node[] {
  const keys = visitorKeys[node.type];
  const out: Node[] = [];
  for (const key of keys) {
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const v of value) if (v) out.push(v as Node);
    } else if (value && typeof value === "object") {
      out.push(value as Node);
    }
  }
  return out;
}

export interface TraverseVisitor {
  enter?(node: Node, parent: Node | null): void | "skip";
  leave?(node: Node, parent: Node | null): void;
}

/** Depth-first traversal. Returning "skip" from `enter` skips the subtree. */
export function traverse(root: Node, visitor: TraverseVisitor): void {
  const walk = (node: Node, parent: Node | null): void => {
    if (visitor.enter?.(node, parent) === "skip") return;
    for (const child of childNodes(node)) walk(child, node);
    visitor.leave?.(node, parent);
  };
  walk(root, null);
}
