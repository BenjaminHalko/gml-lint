/** Operator, condition and accessor type checks (mostly Feather Strict Type mode). */

import type * as AST from "@gml-lint/parser";
import type { FileChecker } from "../../checker.js";
import { typeCategory, unionMembers, type Type } from "../../types.js";
import { defineCheck, type CheckContext } from "../api.js";
import { unparen } from "../util.js";
import { constantClassOf, fromMacro, isKnownStructName, NUMBERISH, show, soleCategory, sureType, typeMeta } from "./common.js";

const ARITHMETIC = new Set(["+", "-", "*", "/", "%", "mod", "div"]);
const BITWISE = new Set(["&", "|", "^", "<<", ">>"]);

// ---------------------------------------------------------------------------
// GM1009: arithmetic on constant groups and asset references
// ---------------------------------------------------------------------------

interface SuspiciousOperand {
  /** Display type, e.g. `Constant.FileAttribute`, `Asset.GMRoom`. */
  type: string;
  constant: boolean;
}

function suspiciousOperand(fc: FileChecker, expr: AST.Expression): SuspiciousOperand | null {
  const e = unparen(expr);
  // Constants and asset references are names (`fa_readonly`, `room`, `obj_x`, `other.sprite_index`).
  if (e.type !== "Identifier" && e.type !== "MemberExpression") return null;
  const cls = constantClassOf(fc, e);
  if (cls) return { type: `Constant.${cls}`, constant: true };
  const t = fc.typeOf(e);
  if (t.kind === "constant" && t.class && t.class !== "All") return { type: show(t), constant: true };
  if (t.kind === "asset" && t.sub) return { type: show(t), constant: false };
  return null;
}

function numericOperandType(fc: FileChecker, e: AST.Expression): string | null {
  const s = suspiciousOperand(fc, e);
  if (s) return s.type;
  const t = sureType(fc, e);
  if (!t || t.kind === "union") return null;
  return t.kind === "real" || t.kind === "int64" || t.kind === "enum" ? show(t) : null;
}

/** Operand types when `node` is arithmetic involving a constant group or asset. */
function gm1009Operands(fc: FileChecker, node: AST.BinaryExpression): { left: string; right: string; flags: boolean } | null {
  if (!ARITHMETIC.has(node.operator)) return null;
  const ls = suspiciousOperand(fc, node.left);
  const rs = suspiciousOperand(fc, node.right);
  if (!ls && !rs) return null;
  const left = ls?.type ?? numericOperandType(fc, node.left);
  const right = rs?.type ?? numericOperandType(fc, node.right);
  if (!left || !right) return null;
  return { left, right, flags: !!ls?.constant && !!rs?.constant };
}

export const GM1009 = defineCheck({
  meta: typeMeta(
    "GM1009",
    "unexpected-type-operation",
    "Operation between types may result in unexpected behavior or an error during runtime.",
  ),
  create(ctx) {
    return {
      BinaryExpression(node) {
        if (fromMacro(node)) return;
        const ops = gm1009Operands(ctx.fc, node);
        if (!ops) return;
        // `a + b + c` on flags: report the innermost operation only.
        for (const side of [node.left, node.right]) {
          const s = unparen(side);
          if (s.type === "BinaryExpression" && s.operator === node.operator && gm1009Operands(ctx.fc, s)) return;
        }
        const op = operatorRange(ctx, node);
        const suggestions =
          ops.flags && node.operator === "+" && op
            ? [{ message: "Combine the flags with '|'.", edits: { range: op, text: "|" } }]
            : undefined;
        ctx.report({
          node,
          message: `Operation ${node.operator} between types '${ops.left}' and '${ops.right}' may result in unexpected behavior or an error during runtime.`,
          ...(suggestions ? { suggestions } : {}),
        });
      },
    };
  },
});

function operatorRange(ctx: CheckContext, node: AST.BinaryExpression): AST.Range | null {
  const between = ctx.getText([node.left.range[1], node.right.range[0]]);
  // The gap may also hold closing parens and comments.
  const i = between.indexOf(node.operator);
  if (i < 0) return null;
  const start = node.left.range[1] + i;
  return [start, start + node.operator.length];
}

// ---------------------------------------------------------------------------
// GM1010: operations that cannot produce a result
// ---------------------------------------------------------------------------

type Kind = Type["kind"];
const NEVER_ARITHMETIC = new Set<Kind>(["struct", "array", "function", "undefined"]);

/** Whether `a op b` definitely fails (numeric handles count as numbers; GM1009 covers those). */
function invalidPair(op: string, a: Type, b: Type): boolean {
  if (NEVER_ARITHMETIC.has(a.kind) || NEVER_ARITHMETIC.has(b.kind)) return true;
  const as = a.kind === "string";
  const bs = b.kind === "string";
  if (!as && !bs) return false;
  if (op === "+") return as !== bs && NUMBERISH.has(as ? b.kind : a.kind);
  // `"ab" * 3` repeats strings at runtime; leave `*` alone.
  if (op === "*") return false;
  return true;
}

function cannotOperate(fc: FileChecker, op: string, left: AST.Expression, right: AST.Expression): [Type, Type] | null {
  const l = sureType(fc, left);
  if (!l) return null;
  const r = sureType(fc, right);
  if (!r) return null;
  for (const a of unionMembers(l)) for (const b of unionMembers(r)) if (!invalidPair(op, a, b)) return null;
  return [l, r];
}

export const GM1010 = defineCheck({
  meta: typeMeta("GM1010", "invalid-type-operation", "Cannot perform operation between types."),
  create(ctx) {
    const report = (node: AST.Node, op: string, types: [Type, Type]) =>
      ctx.report({ node, message: `Cannot perform ${op} operation between types '${show(types[0])}' and '${show(types[1])}'.` });
    return {
      BinaryExpression(node) {
        if (fromMacro(node) || (!ARITHMETIC.has(node.operator) && !BITWISE.has(node.operator))) return;
        const types = cannotOperate(ctx.fc, node.operator, node.left, node.right);
        if (types) report(node, node.operator, types);
      },
      AssignmentExpression(node) {
        if (fromMacro(node)) return;
        const op = node.operator.slice(0, -1);
        if (!node.operator.endsWith("=") || (!ARITHMETIC.has(op) && !BITWISE.has(op))) return;
        const types = cannotOperate(ctx.fc, op, node.left, node.right);
        if (types) report(node, op, types);
      },
    };
  },
});

// ---------------------------------------------------------------------------
// GM1011: implicit cast to Bool
// ---------------------------------------------------------------------------

const NOT_BOOL = new Set<Kind>(["string", "array", "struct", "function", "undefined"]);

export const GM1011 = defineCheck({
  meta: typeMeta(
    "GM1011",
    "implicit-bool-cast",
    "Implicit cast of type to 'Bool' may result in unexpected behavior or an error during runtime.",
  ),
  create(ctx) {
    const check = (test: AST.Expression | null) => {
      if (!test || fromMacro(test)) return;
      const t = sureType(ctx.fc, test);
      if (!t) return;
      const members = unionMembers(t);
      // `undefined | Struct` is the usual "maybe" value; its truthiness test is idiomatic.
      if (members.length > 1 && members.some((m) => m.kind === "undefined")) return;
      if (!members.every((m) => NOT_BOOL.has(m.kind))) return;
      ctx.report({ node: test, message: `Implicit cast of type '${show(t)}' to 'Bool' may result in unexpected behavior or an error during runtime.` });
    };
    return {
      IfStatement: (n) => check(n.test),
      WhileStatement: (n) => check(n.test),
      DoUntilStatement: (n) => check(n.test),
      ForStatement: (n) => check(n.test),
      ConditionalExpression: (n) => check(n.test),
      UnaryExpression: (n) => {
        if (n.operator === "!" || n.operator === "not") check(n.argument);
      },
      LogicalExpression: (n) => {
        if (n.operator === "??") return;
        check(n.left);
        check(n.right);
      },
    };
  },
});

// ---------------------------------------------------------------------------
// GM1028: wrong accessor for the type
// ---------------------------------------------------------------------------

const ACCESSOR_TYPE: Record<AST.Accessor, string> = {
  "": "Array",
  "@": "Array",
  "|": "Id.DsList",
  "?": "Id.DsMap",
  "#": "Id.DsGrid",
  $: "Struct",
};

function accessorAccepts(accessor: AST.Accessor, t: Type): boolean {
  switch (accessor) {
    case "|":
    case "?":
    case "#": {
      const want = accessor === "|" ? "DsList" : accessor === "?" ? "DsMap" : "DsGrid";
      // Legacy code stores data structure handles as plain numbers.
      return (t.kind === "id" && t.sub === want) || t.kind === "real" || t.kind === "int64";
    }
    case "$":
      return t.kind === "struct" || t.kind === "instance";
    default:
      // `a[i]` on reals/strings may be legacy array creation (`a = 0; a[0] = 1`);
      // only data structure handles and structs are definitely wrong.
      return !(t.kind === "struct" || (t.kind === "id" && /^Ds/.test(t.sub)));
  }
}

export const GM1028 = defineCheck({
  meta: typeMeta("GM1028", "wrong-accessor", "Accessor is intended for a different type."),
  create(ctx) {
    return {
      IndexExpression(node) {
        if (fromMacro(node)) return;
        const t = sureType(ctx.fc, node.object);
        if (!t) return;
        const members = unionMembers(t);
        if (members.some((m) => accessorAccepts(node.accessor, m))) return;
        if (members.some((m) => m.kind === "struct" && m.name !== null && !isKnownStructName(ctx.checker, m.name))) return;
        ctx.report({
          node,
          message: `Accessor is intended for type of '${ACCESSOR_TYPE[node.accessor]}' but '${show(t)}' appears instead.`,
        });
      },
    };
  },
});

// ---------------------------------------------------------------------------
// GM1063: ternary branches of differing types
// ---------------------------------------------------------------------------

export const GM1063 = defineCheck({
  meta: typeMeta("GM1063", "ternary-differing-types", "Ternary may yield differing types."),
  create(ctx) {
    return {
      ConditionalExpression(node) {
        if (fromMacro(node)) return;
        const a = sureType(ctx.fc, node.consequent);
        const b = sureType(ctx.fc, node.alternate);
        if (!a || !b) return;
        const ca = soleCategory(a);
        const cb = soleCategory(b);
        if (ca === null || cb === null || ca === cb) return;
        if (typeCategory(a) === "undefined" || typeCategory(b) === "undefined") return;
        ctx.report({ node, message: `Ternary may yield differing types '${show(a)}' and '${show(b)}'.` });
      },
    };
  },
});
