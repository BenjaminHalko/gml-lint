/**
 * GM1008 (assignment to a read-only built-in), GM1031 (assignment to an asset
 * or constant) and GM1030 (reserved name used for a variable/macro).
 */

import type * as AST from "@gml-lint/parser";
import type { Checker } from "../../checker.js";
import { defineCheck } from "../api.js";
import { unparen } from "../util.js";
import { docs, KEYWORD_NAMES, writeTarget } from "./shared.js";

export const GM1008 = defineCheck({
  meta: {
    code: "GM1008",
    name: "no-readonly-assignment",
    description: "The built-in variable is readonly and cannot be assigned to.",
    category: "semantic",
    defaultSeverity: "error",
    preset: "recommended",
    feather: true,
    docs: docs("GM1008"),
  },
  create(ctx) {
    const check = (node: AST.AssignmentExpression | AST.UpdateExpression) => {
      const target = unparen(writeTarget(node));
      if (target.type === "Identifier") {
        const r = ctx.fc.resolve(target);
        if (r?.kind !== "builtin-variable" || r.spec.set) return;
        // In constructors (and other struct scopes) instance built-ins are ordinary fields.
        if (r.spec.instance && ctx.fc.selfAt(target).kind === "struct") return;
        ctx.report({ node: target, message: `The variable '${target.name}' is readonly and cannot be assigned to.` });
      } else if (target.type === "MemberExpression") {
        const m = ctx.fc.resolveMember(target);
        if (m.kind === "builtin-variable" && !m.spec.set) {
          ctx.report({ node: target.property, message: `The variable '${target.property.name}' is readonly and cannot be assigned to.` });
        }
      }
    };
    return { AssignmentExpression: check, UpdateExpression: check };
  },
});

export const GM1031 = defineCheck({
  meta: {
    code: "GM1031",
    name: "no-asset-or-constant-assignment",
    description: "The name is an asset or constant and cannot be assigned to.",
    category: "semantic",
    defaultSeverity: "error",
    preset: "recommended",
    feather: true,
    docs: docs("GM1031"),
  },
  create(ctx) {
    const check = (node: AST.AssignmentExpression | AST.UpdateExpression) => {
      const target = unparen(writeTarget(node));
      if (target.type !== "Identifier") return;
      const r = ctx.fc.resolve(target);
      if (!r) return;
      // Notes, extensions and other non-code resources are not names in code.
      if (r.kind === "asset" && (r.resource.type === "note" || r.resource.type === "extension" || r.resource.type === "other")) return;
      switch (r.kind) {
        case "asset":
        case "script":
        case "room-instance":
        case "builtin-constant":
        case "extension-constant":
        case "enum":
          ctx.report({ node: target, message: `The name '${target.name}' is an asset or constant and cannot be assigned to.` });
      }
    };
    return { AssignmentExpression: check, UpdateExpression: check };
  },
});

/** "instance" for per-instance built-in variables (allowed in constructors), "other" for everything else reserved. */
function reservedKind(checker: Checker, name: string): "instance" | "other" | null {
  if (KEYWORD_NAMES.has(name)) return "other";
  if (/^argument(?:\d{1,2}|_count)?$/.test(name)) return "other";
  const spec = checker.spec;
  if (!spec) return null;
  const v = spec.variables.get(name);
  if (v) return v.instance ? "instance" : "other";
  if (spec.constants.has(name) || spec.functions.has(name)) return "other";
  return null;
}

export const GM1030 = defineCheck({
  meta: {
    code: "GM1030",
    name: "no-reserved-identifier",
    description: "The identifier is reserved and cannot be used as a variable or macro name.",
    category: "semantic",
    defaultSeverity: "error",
    preset: "recommended",
    feather: true,
    docs: docs("GM1030"),
  },
  create(ctx) {
    const report = (id: AST.Identifier, structScope: boolean) => {
      const kind = reservedKind(ctx.checker, id.name);
      if (kind === null || (kind === "instance" && structScope)) return;
      ctx.report({ node: id, message: `The identifier '${id.name}' is reserved and cannot be used as a variable or macro name.` });
    };
    return {
      VariableDeclaration(node) {
        if (node.kind === "globalvar" || node.fromMacro) return;
        for (const d of node.declarations) report(d.id, ctx.fc.selfAt(d).kind === "struct");
      },
      // Parameters are not checked: GameMaker compiles `function f(x, y)` (the
      // parameter shadows the built-in) and Feather documents only var/static/macro.
      MacroDeclaration(node) {
        report(node.id, false);
      },
    };
  },
});
