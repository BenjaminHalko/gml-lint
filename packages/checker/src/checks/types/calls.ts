/** Argument and callee type checks. */

import type * as AST from "@gml-lint/parser";
import type { FileChecker } from "../../checker.js";
import { isUnknown, normaliseConstantClass, unionMembers, type Parameter, type Type } from "../../types.js";
import { defineCheck, type CheckContext } from "../api.js";
import { unparen } from "../util.js";
import { compatible, constantClassOf, constantsOfClass, fromMacro, show, sureType, typeMeta } from "./common.js";

interface TypedArgument {
  arg: AST.Expression;
  param: Parameter;
  index: number;
  /** The callee is a built-in function. */
  builtin: boolean;
  /** The callee's name, for messages. */
  callee: string | null;
}

/** Arguments of a call paired with their (typed) parameters. */
function typedArguments(fc: FileChecker, node: AST.CallExpression | AST.NewExpression): TypedArgument[] {
  const callee = unparen(node.callee);
  const r = callee.type === "Identifier" ? fc.resolve(callee) : null;
  if (r?.kind === "extension-function") return [];
  const builtin = r?.kind === "builtin-function";
  const sig = fc.signatureOfCallee(callee);
  if (!sig || sig.parameters.length === 0) return [];
  const out: TypedArgument[] = [];
  const last = sig.parameters[sig.parameters.length - 1]!;
  node.arguments.forEach((arg, index) => {
    if (!arg) return;
    const param = sig.parameters[index] ?? (last.rest ? last : undefined);
    if (!param || isUnknown(param.type)) return;
    out.push({ arg, param, index, builtin, callee: callee.type === "Identifier" ? callee.name : null });
  });
  return out;
}

const NUMBER_KINDS = new Set<Type["kind"]>(["real", "int64", "bool", "enum", "constant"]);

type Mismatch = { code: "GM1029" | "GM1041"; source: Type; target: Type } | null;

/** Classifies an argument mismatch: GM1029 for String<->Real casts into built-ins, else GM1041. */
function mismatch(fc: FileChecker, a: TypedArgument): Mismatch {
  if (fromMacro(a.arg)) return null;
  const source = sureType(fc, a.arg);
  if (!source) return null;
  const target = a.param.type;
  const members = unionMembers(source);
  // An `undefined` argument usually means "use the default"/"none" (`keyboard_virtual_show(undefined, ...)`),
  // and user JSDoc rarely spells out `|Undefined`.
  if (members.some((m) => m.kind === "undefined")) return null;
  const arg = unparen(a.arg);
  if (arg.type === "Identifier" && (arg.name === "noone" || arg.name === "all" || arg.name === "other" || arg.name === "self")) {
    if (fc.resolve(arg)?.kind === "keyword") return null;
  }
  if (compatible(fc.checker, source, target)) return null;
  if (a.builtin) {
    const targets = unionMembers(target);
    const takesString = targets.some((t) => t.kind === "string");
    const takesNumber = targets.some((t) => t.kind === "real" || t.kind === "int64");
    if (source.kind === "string" && takesNumber) return { code: "GM1029", source, target: targets.find((t) => t.kind === "real" || t.kind === "int64")! };
    if (NUMBER_KINDS.has(source.kind) && takesString && !takesNumber) return { code: "GM1029", source, target: targets.find((t) => t.kind === "string")! };
  }
  return { code: "GM1041", source, target };
}

/** GM1029 and GM1041 classify the same arguments; compute once per call. */
const mismatchCache = new WeakMap<AST.Node, Array<{ arg: AST.Expression; m: NonNullable<Mismatch> }>>();
function callMismatches(fc: FileChecker, node: AST.CallExpression | AST.NewExpression) {
  let list = mismatchCache.get(node);
  if (!list) {
    list = [];
    for (const a of typedArguments(fc, node)) {
      const m = mismatch(fc, a);
      if (m) list.push({ arg: a.arg, m });
    }
    mismatchCache.set(node, list);
  }
  return list;
}

function argumentCheck(ctx: CheckContext, code: "GM1029" | "GM1041") {
  const check = (node: AST.CallExpression | AST.NewExpression) => {
    for (const { arg, m } of callMismatches(ctx.fc, node)) {
      if (m.code !== code) continue;
      ctx.report({
        node: arg,
        message:
          code === "GM1029"
            ? `Potentially dangerous or unintended implicit cast from '${show(m.source)}' to '${show(m.target)}'.`
            : `The type '${show(m.source)}' appears where the type '${show(m.target)}' is expected.`,
      });
    }
  };
  return { CallExpression: check, NewExpression: check };
}

export const GM1029 = defineCheck({
  meta: typeMeta("GM1029", "dangerous-implicit-cast", "Potentially dangerous or unintended implicit cast."),
  create: (ctx) => argumentCheck(ctx, "GM1029"),
});

export const GM1041 = defineCheck({
  meta: typeMeta("GM1041", "argument-type-mismatch", "The type appears where a different type is expected."),
  create: (ctx) => argumentCheck(ctx, "GM1041"),
});

// ---------------------------------------------------------------------------
// GM1044: constant from the wrong group
// ---------------------------------------------------------------------------

export const GM1044 = defineCheck({
  meta: typeMeta("GM1044", "wrong-constant-group", "Constant is expected to be one of a group."),
  create(ctx) {
    if (!ctx.checker.spec) return {};
    const check = (node: AST.CallExpression | AST.NewExpression) => {
      for (const a of typedArguments(ctx.fc, node)) {
        if (fromMacro(a.arg)) continue;
        const targets = unionMembers(a.param.type);
        const groups = targets.filter((t): t is Extract<Type, { kind: "constant" }> => t.kind === "constant" && t.class !== null);
        if (groups.length === 0) continue;
        // `keyboard_check(key: Constant.VirtualKey|Real)` takes any number (`ord("A")`).
        if (targets.some((t) => t.kind === "real" || t.kind === "int64" || isUnknown(t))) continue;
        const cls = constantClassOf(ctx.fc, a.arg);
        if (!cls) continue;
        const wanted = new Set(groups.map((g) => normaliseConstantClass(g.class!)));
        if (wanted.has(normaliseConstantClass(cls))) continue;
        const names = groups.flatMap((g) => {
          const list = constantsOfClass(ctx.checker, g.class!);
          return list.length ? list : [`Constant.${g.class}`];
        });
        ctx.report({ node: a.arg, message: `Constant is expected to be one of the following: ${names.join(", ")}` });
      }
    };
    return { CallExpression: check, NewExpression: check };
  },
});

// ---------------------------------------------------------------------------
// GM1060: calling something that is not a function
// ---------------------------------------------------------------------------

const NOT_CALLABLE = new Set<Type["kind"]>(["real", "int64", "string", "array", "struct", "bool", "undefined"]);

export const GM1060 = defineCheck({
  meta: typeMeta("GM1060", "call-non-function", "Dangerous call to variable that is not a function."),
  create(ctx) {
    return {
      CallExpression(node) {
        if (fromMacro(node)) return;
        const callee = unparen(node.callee);
        if (callee.type === "Identifier") {
          const r = ctx.fc.resolve(callee);
          if (!r) return;
          switch (r.kind) {
            case "builtin-function":
            case "global-function":
            case "script":
            case "extension-function":
            case "self-member":
              return;
          }
        } else if (callee.type !== "MemberExpression" && callee.type !== "IndexExpression") {
          return;
        }
        const t = sureType(ctx.fc, callee);
        if (!t || !unionMembers(t).every((m) => NOT_CALLABLE.has(m.kind))) return;
        ctx.report({ node: node.callee, message: `Dangerous call to variable of type '${show(t)}'.` });
      },
    };
  },
});
