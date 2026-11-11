/** Feather style suggestions: `repeat` instead of `for`, nullish coalescing. */

import type * as AST from "@gml-lint/parser";
import type { FileChecker } from "../../checker.js";
import { defineCheck } from "../api.js";
import { enclosingFunction, unparen } from "../util.js";
import { compact, docs, hasCommentIn, identifierNames, identifiersNamed, isPlainChain } from "./helpers.js";

// ---------------------------------------------------------------------------
// GM2004: for -> repeat
// ---------------------------------------------------------------------------

/** The counter of `var i = e` / `i = e` (single declarator). */
function counterOf(init: AST.ForStatement["init"]): { id: AST.Identifier; value: AST.Expression; declared: boolean } | null {
  if (!init) return null;
  if (init.type === "VariableDeclaration") {
    if (init.kind !== "var" || init.declarations.length !== 1) return null;
    const d = init.declarations[0]!;
    return d.init ? { id: d.id, value: d.init, declared: true } : null;
  }
  const e = init.expression;
  if (e.type !== "AssignmentExpression" || (e.operator !== "=" && e.operator !== ":=") || e.left.type !== "Identifier") return null;
  return { id: e.left, value: e.right, declared: false };
}

/** `i < n`, `i <= n`, `i != n`: returns `n`. */
function boundOf(test: AST.Expression | null, name: string): AST.Expression | null {
  if (!test) return null;
  const t = unparen(test);
  if (t.type !== "BinaryExpression") return null;
  if (t.operator !== "<" && t.operator !== "<=" && t.operator !== "!=" && t.operator !== "<>") return null;
  const l = unparen(t.left);
  return l.type === "Identifier" && l.name === name ? t.right : null;
}

/** `i++`, `++i`, `i += 1`. */
function isIncrement(update: AST.ExpressionStatement | null, name: string): boolean {
  if (!update) return false;
  const e = update.expression;
  if (e.type === "UpdateExpression") {
    const a = unparen(e.argument);
    return e.operator === "++" && a.type === "Identifier" && a.name === name;
  }
  if (e.type === "AssignmentExpression" && e.operator === "+=" && e.left.type === "Identifier" && e.left.name === name) {
    const r = unparen(e.right);
    return r.type === "Literal" && r.value === 1;
  }
  return false;
}

/**
 * Deterministic built-ins allowed in a loop bound. The spec's `pure` flag is
 * not enough: `irandom_range` and `get_timer` are "pure" but differ per call.
 */
const DETERMINISTIC = new Set([
  "abs", "floor", "ceil", "round", "min", "max", "clamp", "sqrt", "sqr", "power", "lerp", "sign", "frac",
  "array_length", "string_length", "ds_list_size", "ds_map_size", "ds_grid_width", "ds_grid_height",
]);

/**
 * Whether a loop bound gives the same value on every evaluation (repeat
 * evaluates its count once, `for` re-evaluates the test).
 */
function isStableBound(fc: FileChecker, e: AST.Expression): boolean {
  switch (e.type) {
    case "Literal":
    case "Identifier":
      return true;
    case "ParenthesizedExpression":
      return isStableBound(fc, e.expression);
    case "MemberExpression":
      return isStableBound(fc, e.object);
    case "IndexExpression":
      return isStableBound(fc, e.object) && e.indices.every((i) => isStableBound(fc, i));
    case "UnaryExpression":
      return isStableBound(fc, e.argument);
    case "BinaryExpression":
    case "LogicalExpression":
      return isStableBound(fc, e.left) && isStableBound(fc, e.right);
    case "CallExpression": {
      const callee = unparen(e.callee);
      if (callee.type !== "Identifier" || !DETERMINISTIC.has(callee.name)) return false;
      if (fc.resolve(callee)?.kind !== "builtin-function") return false;
      return e.arguments.every((a) => a === null || isStableBound(fc, a));
    }
    default:
      return false;
  }
}

export const GM2004 = defineCheck({
  meta: {
    code: "GM2004",
    name: "prefer-repeat",
    description: "This for statement does not use its index and can be written as a repeat statement instead.",
    category: "style",
    feather: true,
    docs: docs("GM2004"),
  },
  create(ctx) {
    const fc = ctx.fc;
    return {
      ForStatement(node) {
        const counter = counterOf(node.init);
        if (!counter) return;
        const name = counter.id.name;
        const bound = boundOf(node.test, name);
        if (!bound || !isIncrement(node.update, name) || !isStableBound(fc, bound)) return;
        if (identifiersNamed(counter.value, name).length) return;
        const boundNames = identifierNames(bound);
        if (boundNames.has(name)) return;
        // The body must not mention the counter, nor anything the bound depends on
        // (repeat evaluates its count once).
        const bodyNames = identifierNames(node.body);
        if (bodyNames.has(name)) return;
        for (const n of boundNames) if (bodyNames.has(n)) return;
        // Assigning a non-local counter has effects visible elsewhere.
        if (!counter.declared && fc.resolve(counter.id)?.kind !== "local") return;
        // The counter's final value must not be read after the loop.
        const fn = enclosingFunction(fc, node);
        const after = identifiersNamed(fn.type === "Program" ? fn : fn.body, name).filter((id) => id.range[0] >= node.range[1]);
        if (after.length) {
          const first = after[0]!;
          const p = fc.parent(first);
          const reinit =
            (p?.type === "VariableDeclarator" && p.id === first && p.init !== null) ||
            (p?.type === "AssignmentExpression" && p.left === first && (p.operator === "=" || p.operator === ":=") && !identifiersNamed(p.right, name).length);
          if (!reinit) return;
        }
        ctx.report({
          range: [node.range[0], node.body.range[0]],
          message: "This for statement does not use its index and can be written as a repeat statement instead.",
        });
      },
    };
  },
});

// ---------------------------------------------------------------------------
// GM2061: nullish coalescing
// ---------------------------------------------------------------------------

const isUndefinedLiteral = (e: AST.Expression) => {
  const u = unparen(e);
  return u.type === "Literal" && u.kind === "undefined";
};

/**
 * If `test` checks a plain variable/member chain against undefined, returns
 * it and whether the check is positive (`== undefined`, `is_undefined`).
 */
function undefinedTest(fc: FileChecker, test: AST.Expression): { subject: AST.Expression; isUndefined: boolean } | null {
  let t = unparen(test);
  let negated = false;
  if (t.type === "UnaryExpression" && (t.operator === "!" || t.operator === "not")) {
    negated = true;
    t = unparen(t.argument);
  }
  if (t.type === "BinaryExpression" && !negated) {
    const eq = t.operator === "==" || t.operator === "=";
    const ne = t.operator === "!=" || t.operator === "<>";
    if (!eq && !ne) return null;
    const l = unparen(t.left);
    const r = unparen(t.right);
    const subject = isUndefinedLiteral(r) ? l : isUndefinedLiteral(l) ? r : null;
    if (!subject || !isPlainChain(subject)) return null;
    return { subject, isUndefined: eq };
  }
  if (t.type === "CallExpression" && t.arguments.length === 1) {
    const callee = unparen(t.callee);
    if (callee.type !== "Identifier" || callee.name !== "is_undefined") return null;
    const kind = fc.resolve(callee)?.kind;
    if (kind === "local" || kind === "global-function" || kind === "instance-var") return null;
    const arg = t.arguments[0];
    if (!arg) return null;
    const subject = unparen(arg);
    if (!isPlainChain(subject)) return null;
    return { subject, isUndefined: !negated };
  }
  return null;
}

/** Wraps an operand of `??` in parentheses unless it is primary. */
function operand(text: string, e: AST.Expression): string {
  switch (e.type) {
    case "Identifier":
    case "Literal":
    case "TemplateLiteral":
    case "ArrayExpression":
    case "StructExpression":
    case "ParenthesizedExpression":
    case "CallExpression":
    case "MemberExpression":
    case "IndexExpression":
    case "NewExpression":
      return text;
    default:
      return `(${text})`;
  }
}

export const GM2061 = defineCheck({
  meta: {
    code: "GM2061",
    name: "prefer-nullish-coalescing",
    description: "Opportunity to use nullish coalesce operator.",
    category: "style",
    feather: true,
    fixable: true,
    docs: docs("GM2061"),
  },
  create(ctx) {
    const message = "Opportunity to use nullish coalesce operator.";
    const same = (a: AST.Node, b: AST.Node) => compact(ctx.getText(a)) === compact(ctx.getText(b));
    return {
      IfStatement(node) {
        if (node.alternate) return;
        const t = undefinedTest(ctx.fc, node.test);
        if (!t || !t.isUndefined) return;
        let body: AST.Statement = node.consequent;
        if (body.type === "BlockStatement") {
          if (body.body.length !== 1) return;
          body = body.body[0]!;
        }
        if (body.type !== "ExpressionStatement") return;
        const a = body.expression;
        if (a.type !== "AssignmentExpression" || a.operator !== "=" || !same(a.left, t.subject)) return;
        const fix = hasCommentIn(ctx.file, node.range)
          ? undefined
          : { range: node.range, text: `${ctx.getText(t.subject)} ??= ${ctx.getText(a.right)};` };
        ctx.report({ node, message, ...(fix ? { fix } : {}) });
      },
      ConditionalExpression(node) {
        const t = undefinedTest(ctx.fc, node.test);
        if (!t) return;
        const kept = t.isUndefined ? node.alternate : node.consequent;
        const fallback = t.isUndefined ? node.consequent : node.alternate;
        if (!same(unparen(kept), t.subject)) return;
        const fix = hasCommentIn(ctx.file, node.range)
          ? undefined
          : { range: node.range, text: `${ctx.getText(t.subject)} ?? ${operand(ctx.getText(fallback), fallback)}` };
        ctx.report({ node, message, ...(fix ? { fix } : {}) });
      },
    };
  },
});

export const styleChecks = [GM2004, GM2061];
