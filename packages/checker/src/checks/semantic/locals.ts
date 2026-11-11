/** Local-variable rules: GM2018 (uninitialised `var` in a loop) and GM2043 (local used outside its block). */

import type * as AST from "@gml-lint/parser";
import { childNodes } from "@gml-lint/parser";
import type { FileChecker } from "../../checker.js";
import { defineCheck } from "../api.js";
import { isFunctionNode } from "../util.js";
import { statementList } from "../syntax/helpers.js";
import { docs, isDeclaringOperator, within } from "./shared.js";

// ---------------------------------------------------------------------------
// GM2018
// ---------------------------------------------------------------------------

/** The loop whose body (re-executed each iteration) contains `node`, stopping at function boundaries. */
function enclosingLoopBody(fc: FileChecker, node: AST.Node): AST.Node | null {
  let prev: AST.Node = node;
  for (const a of fc.ancestors(node)) {
    if (isFunctionNode(a) || a.type === "Program") return null;
    if ((a.type === "WhileStatement" || a.type === "DoUntilStatement" || a.type === "RepeatStatement" || a.type === "ForStatement") && a.body === prev) {
      return a;
    }
    prev = a;
  }
  return null;
}

function mentions(node: AST.Node, name: string): boolean {
  if (node.type === "Identifier") return node.name === name;
  if (node.type === "MemberExpression") return mentions(node.object, name); // `a.name` is not the local
  if (node.type === "StructProperty") return node.value ? mentions(node.value, name) : node.key.type === "Identifier" && node.key.name === name;
  for (const c of childNodes(node)) if (mentions(c, name)) return true;
  return false;
}

/**
 * Whether `stmt` assigns `name` on every path before reading it:
 * `name = <expr not using name>;`, a block whose first mention does, or an
 * if/else whose branches both do.
 */
function definitelyAssigns(stmt: AST.Statement, name: string): boolean {
  switch (stmt.type) {
    case "ExpressionStatement": {
      const e = stmt.expression;
      return (
        e.type === "AssignmentExpression" && isDeclaringOperator(e.operator) && e.left.type === "Identifier" && e.left.name === name && !mentions(e.right, name)
      );
    }
    case "BlockStatement": {
      const first = stmt.body.find((s) => mentions(s, name));
      return first !== undefined && definitelyAssigns(first, name);
    }
    case "IfStatement":
      return stmt.alternate !== null && !mentions(stmt.test, name) && definitelyAssigns(stmt.consequent, name) && definitelyAssigns(stmt.alternate, name);
    default:
      return false;
  }
}

export const GM2018 = defineCheck({
  meta: {
    code: "GM2018",
    name: "no-uninitialized-var-in-loop",
    description: "Potentially dangerous variable declaration.",
    category: "semantic",
    feather: true,
    docs: docs("GM2018"),
  },
  create(ctx) {
    return {
      VariableDeclaration(node) {
        if (node.kind !== "var" || node.fromMacro) return;
        if (node.declarations.every((d) => d.init !== null)) return;
        if (!enclosingLoopBody(ctx.fc, node)) return;
        const parent = ctx.fc.parent(node);
        const list = parent ? statementList(parent) : null;
        if (!list) return;
        const following = list.slice(list.indexOf(node) + 1);
        for (const d of node.declarations) {
          if (d.init !== null) continue;
          const name = d.id.name;
          // Silent when the next statement mentioning the variable assigns it on every path.
          const next = following.find((s) => mentions(s, name));
          if (!next || definitelyAssigns(next, name)) continue;
          ctx.report({ node: d, message: "Potentially dangerous variable declaration." });
        }
      },
    };
  },
});

// ---------------------------------------------------------------------------
// GM2043
// ---------------------------------------------------------------------------

/** Innermost `{ }` block (or the Program) around a declaration. */
function blockOf(fc: FileChecker, id: AST.Identifier, cache: WeakMap<AST.Node, AST.Node>): AST.Node {
  const hit = cache.get(id);
  if (hit) return hit;
  let block: AST.Node = fc.file.ast;
  for (const a of fc.ancestors(id)) {
    if (a.type === "BlockStatement" || a.type === "Program") {
      block = a;
      break;
    }
  }
  cache.set(id, block);
  return block;
}

export const GM2043 = defineCheck({
  meta: {
    code: "GM2043",
    name: "no-local-outside-scope",
    description: "Attempting to access the local variable outside of the scope it was defined in.",
    category: "semantic",
    feather: true,
    docs: docs("GM2043"),
  },
  create(ctx) {
    const cache = new WeakMap<AST.Node, AST.Node>();
    // One report per variable (its first out-of-scope use), not per reference.
    const reported = new Set<object>();
    const once = (key: object, node: AST.Identifier) => {
      if (reported.has(key)) return;
      reported.add(key);
      ctx.report({ node, message: `Attempting to access the local variable '${node.name}' outside of the scope it was defined in.` });
    };
    return {
      Identifier(node) {
        const r = ctx.fc.resolve(node);
        if (!r) return;
        if (r.kind === "local") {
          const sym = r.symbol;
          if (sym.kind !== "local" || sym.scope.file !== ctx.file) return;
          for (const d of sym.declarations) {
            if (d.range[0] <= node.range[0] && within(node, blockOf(ctx.fc, d, cache).range)) return;
          }
          once(sym, node);
        } else if (r.kind === "self-member" || r.kind === "instance-var" || r.kind === "struct-field" || r.kind === "global-var") {
          // Used before its `var` declaration later in the same function.
          const sym = ctx.fc.scopeOf(node).locals.get(node.name);
          if (sym?.kind !== "local" || sym.declarations[0]!.range[0] <= node.range[0]) return;
          once(sym, node);
        }
      },
    };
  },
});
