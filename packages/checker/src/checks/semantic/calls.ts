/** Call rules: GM2023 (argument evaluation order) and GM2039 (script asset called like a function). */

import type * as AST from "@gml-lint/parser";
import { defineCheck } from "../api.js";
import { unparen } from "../util.js";
import { docs } from "./shared.js";

export const GM2023 = defineCheck({
  meta: {
    code: "GM2023",
    name: "argument-evaluation-order",
    description: "Evaluation order of function calls in argument list not guaranteed between platforms.",
    category: "semantic",
    feather: true,
    docs: docs("GM2023"),
  },
  create(ctx) {
    const isImpureCall = (arg: AST.Expression | null): boolean => {
      if (!arg) return false;
      const e = unparen(arg);
      if (e.type !== "CallExpression") return false;
      const sig = ctx.fc.signatureOfCallee(unparen(e.callee));
      return sig !== null && !sig.pure;
    };
    const check = (node: AST.CallExpression | AST.NewExpression) => {
      if (node.arguments.length < 2) return;
      let impure = 0;
      for (const a of node.arguments) if (isImpureCall(a) && ++impure >= 2) break;
      if (impure >= 2) ctx.report({ node, message: "Evaluation order of function calls in argument list not guaranteed between platforms." });
    };
    return { CallExpression: check, NewExpression: check };
  },
});

export const GM2039 = defineCheck({
  meta: {
    code: "GM2039",
    name: "no-script-asset-call",
    description: "Call to execute a global script resource like a function is deprecated.",
    category: "semantic",
    feather: true,
    docs: docs("GM2039"),
  },
  create(ctx) {
    const b = ctx.checker.binding;
    return {
      CallExpression(node) {
        const callee = unparen(node.callee);
        if (callee.type !== "Identifier") return;
        const r = ctx.fc.resolve(callee);
        if (r?.kind !== "script") return;
        // A top-level `name = function () {}` in some script makes the call fine.
        if (b.globals.has(callee.name) || b.unknownTargetWrites.has(callee.name)) return;
        ctx.report({ node: callee, message: "Call to execute a global script resource like a function is deprecated." });
      },
    };
  },
});
