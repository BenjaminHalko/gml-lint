/** Function, JSDoc and variable type consistency checks. */

import type * as AST from "@gml-lint/parser";
import type { LocalSymbol } from "../../binder.js";
import type { DocComment } from "../../jsdoc.js";
import { typeCategory, validateTypeText, type Type, type TypeCategory } from "../../types.js";
import { defineCheck } from "../api.js";
import { unparen } from "../util.js";
import { compatible, fromMacro, isSure, knownConstantClasses, scopeOfFunction, show, soleCategory, sureType, typeMeta, withoutUndefined } from "./common.js";

// ---------------------------------------------------------------------------
// GM1035: inconsistent return types (no JSDoc @returns)
// ---------------------------------------------------------------------------

export const GM1035 = defineCheck({
  meta: typeMeta("GM1035", "inconsistent-return-type", "Return type differs from previously established return type.", "strict"),
  create(ctx) {
    const check = (node: AST.FunctionLike) => {
      const scope = scopeOfFunction(ctx.fc, node);
      // With a JSDoc @returns type the established type is the documented one (GM1045).
      if (!scope || node.isConstructor || scope.doc?.returns?.type) return;
      let established: TypeCategory | null = null;
      for (const r of scope.returns) {
        if (!r.argument || fromMacro(r)) continue;
        const t = sureType(ctx.fc, r.argument);
        const cat = t ? soleCategory(t) : null;
        if (cat === null) continue;
        if (established === null) established = cat;
        else if (cat !== established) ctx.report({ node: r.argument, message: "Return type differs from previously established return type." });
      }
    };
    return { FunctionDeclaration: check, FunctionExpression: check };
  },
});

// ---------------------------------------------------------------------------
// GM1042: JSDoc @param name differs from the parameter
// ---------------------------------------------------------------------------

export const GM1042 = defineCheck({
  meta: typeMeta("GM1042", "jsdoc-param-name", "Parameter name differs from the name specified in jsdoc.", "recommended"),
  create(ctx) {
    const check = (node: AST.FunctionLike) => {
      const doc = scopeOfFunction(ctx.fc, node)?.doc;
      if (!doc || doc.ignore) return;
      node.params.forEach((p, i) => {
        const d = doc.params[i];
        if (!d || d.name.startsWith("...") || d.name === p.id.name) return;
        ctx.report({ node: p.id, message: `Parameter name '${p.id.name}' differs from '${d.name}' specified in jsdoc.` });
      });
    };
    return { FunctionDeclaration: check, FunctionExpression: check };
  },
});

// ---------------------------------------------------------------------------
// GM1045: value differs from the JSDoc type
// ---------------------------------------------------------------------------

export const GM1045 = defineCheck({
  meta: typeMeta("GM1045", "jsdoc-type-mismatch", "Type differs from type specified in jsdoc.", "recommended"),
  create(ctx) {
    const c = ctx.checker;
    const mismatch = (value: AST.Expression, expected: Type) => {
      if (fromMacro(value)) return;
      // `noone` is the conventional "none" for instance/asset-typed values.
      const u = unparen(value);
      if (u.type === "Identifier" && u.name === "noone" && ctx.fc.resolve(u)?.kind === "keyword") return;
      const raw = sureType(ctx.fc, value);
      if (!raw) return;
      const t = withoutUndefined(raw);
      if (t.kind === "undefined") return; // `undefined` as "no value" is idiomatic
      if (compatible(c, t, expected)) return;
      ctx.report({ node: value, message: `Type '${show(t)}' differs from type '${show(expected)}' specified in jsdoc.` });
    };
    const check = (node: AST.FunctionLike) => {
      const scope = scopeOfFunction(ctx.fc, node);
      const doc = scope?.doc;
      if (!scope || !doc || doc.ignore) return;
      const expected = doc.returns?.type;
      if (expected && !node.isConstructor && isSure(c, expected)) {
        for (const r of scope.returns) if (r.argument) mismatch(r.argument, expected);
      }
      for (const p of node.params) {
        const d = doc.params.find((dp) => dp.name === p.id.name);
        if (!d?.type || !isSure(c, d.type)) continue;
        const sym = scope.locals.get(p.id.name);
        if (sym?.kind !== "parameter") continue;
        for (const v of sym.values) if (v) mismatch(v, d.type);
      }
    };
    return { FunctionDeclaration: check, FunctionExpression: check };
  },
});

// ---------------------------------------------------------------------------
// GM1062: malformed JSDoc types
// ---------------------------------------------------------------------------

export const GM1062 = defineCheck({
  meta: typeMeta("GM1062", "jsdoc-malformed-type", "Malformed type in jsdoc.", "recommended"),
  create(ctx) {
    const c = ctx.checker;
    const constantClasses = knownConstantClasses(c);
    const isKnownName = (name: string) =>
      c.binding.constructors.has(name) || c.binding.enums.has(name) || !!c.spec?.structures.has(name) || !!c.spec?.enumerations.has(name);
    const validate = (doc: DocComment) => {
      const entries: Array<{ text: string | null; range: AST.Range | null }> = doc.params.map((p) => ({ text: p.typeText, range: p.typeRange }));
      if (doc.returns) entries.push({ text: doc.returns.typeText, range: doc.returns.typeRange });
      for (const e of entries) {
        if (e.text === null || !e.range) continue;
        if (validateTypeText(e.text, { isKnownName, constantClasses }) === null) continue;
        ctx.report({ range: e.range, message: `Malformed type '${e.text}' in jsdoc.` });
      }
    };
    return {
      Program() {
        for (const doc of ctx.file.docs) if (!doc.ignore) validate(doc);
      },
    };
  },
});

// ---------------------------------------------------------------------------
// GM1043: type reassignment of local variables
// ---------------------------------------------------------------------------

export const GM1043 = defineCheck({
  meta: typeMeta("GM1043", "type-reassignment", "Potentially unintentional type reassignment.", "strict"),
  create(ctx) {
    const checkSymbol = (sym: LocalSymbol) => {
      if (sym.values.length < 2) return; // a single assignment cannot change type
      let established: { type: Type; cat: TypeCategory } | null = null;
      for (const v of sym.values) {
        if (!v || fromMacro(v)) continue;
        const t = sureType(ctx.fc, v);
        const cat = t ? soleCategory(t) : null;
        if (!t || cat === null || typeCategory(t) === "undefined") continue;
        if (!established) {
          established = { type: t, cat };
          continue;
        }
        if (cat === established.cat) continue;
        const at = ctx.fc.parent(v) ?? v;
        ctx.report({ node: at, message: `Potentially unintentional type reassignment from '${show(established.type)}' to '${show(t)}'.` });
        established = { type: t, cat };
      }
    };
    return {
      Program() {
        for (const scope of ctx.fc.scopes()) {
          for (const sym of scope.locals.values()) if (sym.kind === "local") checkSymbol(sym);
        }
      },
    };
  },
});
