/** GM1054 (inheriting from a missing/non-constructor function) and GM1058 (`new` on a non-constructor). */

import { defineCheck } from "../api.js";
import { unparen } from "../util.js";
import { docs } from "./shared.js";

export const GM1054 = defineCheck({
  meta: {
    code: "GM1054",
    name: "no-invalid-constructor-parent",
    description: "Cannot inherit from non-existent function.",
    category: "semantic",
    defaultSeverity: "error",
    preset: "recommended",
    feather: true,
    docs: docs("GM1054"),
  },
  create(ctx) {
    const b = ctx.checker.binding;
    return {
      ConstructorParent(node) {
        const callee = node.callee;
        const name = callee.name;
        const r = ctx.fc.resolve(callee);
        if (!r) return;
        if (r.kind === "global-function") {
          if (r.all.some((i) => i.node.isConstructor)) return;
          ctx.report({ node: callee, message: `Cannot inherit from '${name}' as it is not a constructor function.` });
          return;
        }
        if (r.kind !== "self-member") return;
        // Defined somewhere the resolver does not look (constructor expressions, globals, dynamic writes)?
        if (b.constructors.has(name) || b.globals.has(name) || b.globalvars.has(name) || b.unknownTargetWrites.has(name)) return;
        if (ctx.checker.spec === null) return;
        ctx.report({ node: callee, message: `Cannot inherit from non-existent function '${name}'.` });
      },
    };
  },
});

export const GM1058 = defineCheck({
  meta: {
    code: "GM1058",
    name: "no-new-non-constructor",
    description: "Cannot 'new' the identifier as it is not a constructor function.",
    category: "semantic",
    defaultSeverity: "error",
    preset: "recommended",
    feather: true,
    docs: docs("GM1058"),
  },
  create(ctx) {
    return {
      NewExpression(node) {
        const callee = unparen(node.callee);
        if (callee.type !== "Identifier") return;
        const r = ctx.fc.resolve(callee);
        let bad = false;
        if (r?.kind === "global-function") bad = r.all.every((i) => !i.node.isConstructor);
        // Built-ins documented as returning a struct may be constructible; leave them alone.
        else if (r?.kind === "builtin-function") bad = !/struct/i.test(r.spec.returnType);
        if (bad) ctx.report({ node: callee, message: `Cannot 'new' the identifier '${callee.name}' as it is not a constructor function.` });
      },
    };
  },
});
