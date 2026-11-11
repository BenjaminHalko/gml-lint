/** GM1017 / GM1023 / GM1024: use of deprecated functions, constants and built-in variables. */

import { defineCheck } from "../api.js";
import { docs } from "./shared.js";

export const GM1017 = defineCheck({
  meta: {
    code: "GM1017",
    name: "no-deprecated-function",
    description: "The function is deprecated and usage is discouraged.",
    category: "semantic",
    feather: true,
    docs: docs("GM1017"),
  },
  create(ctx) {
    return {
      Identifier(node) {
        const r = ctx.fc.resolve(node);
        if (!r) return;
        const deprecated =
          (r.kind === "builtin-function" && r.spec.deprecated) || (r.kind === "global-function" && r.info.doc?.deprecated === true);
        if (deprecated) ctx.report({ node, message: `The function '${node.name}' is deprecated and usage is discouraged.` });
      },
    };
  },
});

export const GM1023 = defineCheck({
  meta: {
    code: "GM1023",
    name: "no-deprecated-constant",
    description: "The constant is deprecated and usage is discouraged.",
    category: "semantic",
    feather: true,
    docs: docs("GM1023"),
  },
  create(ctx) {
    return {
      Identifier(node) {
        const r = ctx.fc.resolve(node);
        if (r?.kind === "builtin-constant" && r.spec.deprecated) {
          ctx.report({ node, message: `The constant '${node.name}' is deprecated and usage is discouraged.` });
        }
      },
    };
  },
});

export const GM1024 = defineCheck({
  meta: {
    code: "GM1024",
    name: "no-deprecated-variable",
    description: "The built-in variable is deprecated and usage is discouraged.",
    category: "semantic",
    feather: true,
    docs: docs("GM1024"),
  },
  create(ctx) {
    const message = (name: string) => `The built-in variable '${name}' is deprecated and usage is discouraged.`;
    return {
      Identifier(node) {
        const r = ctx.fc.resolve(node);
        if (r?.kind !== "builtin-variable" || !r.spec.deprecated) return;
        // Instance built-ins are plain fields inside constructors.
        if (r.spec.instance && ctx.fc.selfAt(node).kind === "struct") return;
        ctx.report({ node, message: message(node.name) });
      },
      MemberExpression(node) {
        const m = ctx.fc.resolveMember(node);
        if (m.kind === "builtin-variable" && m.spec.deprecated) ctx.report({ node: node.property, message: message(node.property.name) });
      },
    };
  },
});
