/**
 * GM1012 (dot on a value that holds no variables), GM1050 (local accessed
 * through `self.`/`other.`) and GM1052 (`delete` on a non-struct).
 */

import type * as AST from "@gml-lint/parser";
import type { Type } from "../../types.js";
import { defineCheck } from "../api.js";
import { unparen } from "../util.js";
import { docs, isDefinitely, writtenMemberNames } from "./shared.js";

const NO_VARIABLES: ReadonlySet<Type["kind"]> = new Set(["real", "int64", "string", "bool", "undefined"]);
const NUMERIC: ReadonlySet<Type["kind"]> = new Set(["real", "int64"]);

export const GM1012 = defineCheck({
  meta: {
    code: "GM1012",
    name: "no-malformed-variable-addressing",
    description: "Malformed variable addressing expression.",
    category: "type",
    defaultSeverity: "error",
    preset: "strict",
    feather: true,
    docs: docs("GM1012"),
  },
  create(ctx) {
    const c = ctx.checker;
    /** Variables whose inferred type could be missing writes made through unknown targets. */
    const untrusted = (e: AST.Expression): boolean => {
      if (e.type === "Identifier") {
        const r = ctx.fc.resolve(e);
        if (!r) return true;
        if (r.kind === "local") return false;
        if (r.kind === "instance-var") return c.binding.unknownTargetWrites.has(e.name) || c.objectIsDynamic(r.object);
        if (r.kind === "struct-field" || r.kind === "global-var") return c.binding.unknownTargetWrites.has(e.name);
        // Built-ins have spec types, but numeric built-ins (e.g. `other` legacy ids) are not worth flagging.
        return true;
      }
      if (e.type === "MemberExpression") return c.binding.unknownTargetWrites.has(e.property.name);
      return false;
    };
    return {
      MemberExpression(node) {
        const obj = unparen(node.object);
        if (obj.type === "Identifier" || obj.type === "MemberExpression" || obj.type === "CallExpression") {
          const t = ctx.fc.typeOf(obj);
          if (!isDefinitely(t, NO_VARIABLES)) return;
          // Numbers are legacy instance ids in old code; only trust non-numeric types from variables.
          if (isDefinitely(t, NUMERIC) && obj.type !== "CallExpression") return;
          if (untrusted(obj)) return;
        } else if (obj.type !== "Literal" && obj.type !== "TemplateLiteral") {
          return;
        }
        ctx.report({ node: node.object, message: "Malformed variable addressing expression." });
      },
    };
  },
});

export const GM1050 = defineCheck({
  meta: {
    code: "GM1050",
    name: "no-local-member-access",
    description: "The identifier is declared as a local variable and cannot be accessed in this way.",
    category: "semantic",
    defaultSeverity: "error",
    preset: "recommended",
    feather: true,
    docs: docs("GM1050"),
  },
  create(ctx) {
    const c = ctx.checker;
    return {
      MemberExpression(node) {
        const obj = unparen(node.object);
        if (obj.type !== "Identifier") return;
        const r = ctx.fc.resolve(obj);
        if (r?.kind !== "keyword" || (r.name !== "self" && r.name !== "other")) return;
        const name = node.property.name;
        const local = ctx.fc.scopeOf(node).locals.get(name);
        if (!local || local.kind === "static") return;
        const m = ctx.fc.resolveMember(node);
        if (m.kind === "undeclared") {
          if (m.owner !== "object" && m.owner !== "struct") return;
          if (c.binding.unknownTargetWrites.has(name)) return;
          if (m.owner === "object" && c.objectIsDynamic(m.ownerName)) return;
        } else if (m.kind === "unknown") {
          if (c.binding.dynamicUnknown || writtenMemberNames(c).has(name)) return;
        } else {
          return;
        }
        ctx.report({ node: node.property, message: `The identifier '${name}' is declared as a local variable and cannot be accessed in this way.` });
      },
    };
  },
});

const NOT_STRUCT: ReadonlySet<Type["kind"]> = new Set([
  "array", "real", "int64", "string", "bool", "undefined", "id", "pointer", "instance", "asset", "constant", "enum",
]);

export const GM1052 = defineCheck({
  meta: {
    code: "GM1052",
    name: "no-delete-non-struct",
    description: "The delete operator can only act on a variable of type 'struct'.",
    category: "type",
    defaultSeverity: "warning",
    preset: "strict",
    feather: true,
    docs: docs("GM1052"),
  },
  create(ctx) {
    const c = ctx.checker;
    return {
      DeleteStatement(node) {
        const arg = unparen(node.argument);
        let name: string | null = null;
        if (arg.type === "Identifier") {
          const r = ctx.fc.resolve(arg);
          if (r?.kind !== "local" && r?.kind !== "instance-var" && r?.kind !== "struct-field" && r?.kind !== "global-var") return;
          if (r.kind === "instance-var" && c.objectIsDynamic(r.object)) return;
          name = arg.name;
        } else if (arg.type === "MemberExpression") {
          name = arg.property.name;
        } else {
          return;
        }
        if (c.binding.unknownTargetWrites.has(name)) return;
        const t = ctx.fc.typeOf(arg);
        if (!isDefinitely(t, NOT_STRUCT)) return;
        ctx.report({ node: node.argument, message: "The delete operator can only act on a variable of type 'struct'." });
      },
    };
  },
});
