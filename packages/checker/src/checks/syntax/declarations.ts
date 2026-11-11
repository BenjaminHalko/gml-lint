/**
 * Declaration-level Feather rules: enums, macros, global functions,
 * parameters and the `argument` built-ins.
 */

import type * as AST from "@gml-lint/parser";
import { defineCheck, type RelatedLocation } from "../api.js";
import type { FunctionScope } from "../../binder.js";
import type { FileChecker } from "../../checker.js";
import type { SourceFile } from "../../program.js";
import { byLocation, docs } from "./helpers.js";

const MAX_MACRO_DEPTH = 8;

export const GM1002 = defineCheck({
  meta: {
    code: "GM1002",
    name: "no-globalvar-initializer",
    description: "globalvar does not support inline initializers.",
    category: "syntax",
    defaultSeverity: "error",
    preset: "syntax",
    feather: true,
    docs: docs("GM1002"),
  },
  create(ctx) {
    return {
      VariableDeclaration(node) {
        if (node.kind !== "globalvar") return;
        for (const d of node.declarations) {
          if (d.init) ctx.report({ node: d, message: "globalvar does not support inline initializers." });
        }
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

type ConstValue = { kind: "num"; value: number } | { kind: "bad" } | { kind: "unknown" };
const UNKNOWN: ConstValue = { kind: "unknown" };
const BAD: ConstValue = { kind: "bad" };

/**
 * Evaluates an enum initializer. `bad` means definitely not an integer
 * constant; `unknown` means we cannot tell (constants, enum members, macros
 * without a parsed body, calls).
 */
function evalConst(fc: FileChecker, e: AST.Expression, depth: number): ConstValue {
  switch (e.type) {
    case "ParenthesizedExpression":
      return evalConst(fc, e.expression, depth);
    case "Literal":
      if (e.kind === "real" || e.kind === "hex" || e.kind === "binary" || e.kind === "colour") {
        return typeof e.value === "number" ? { kind: "num", value: e.value } : UNKNOWN;
      }
      if (e.kind === "string" || e.kind === "verbatim" || e.kind === "undefined") return BAD;
      return UNKNOWN; // booleans: the compiler treats them as 0/1
    case "TemplateLiteral":
    case "ArrayExpression":
    case "StructExpression":
    case "FunctionExpression":
      return BAD;
    case "UnaryExpression": {
      const v = evalConst(fc, e.argument, depth);
      if (v.kind !== "num") return v;
      if (e.operator === "-") return { kind: "num", value: -v.value };
      if (e.operator === "+") return v;
      if (e.operator === "~") return Number.isInteger(v.value) ? { kind: "num", value: ~v.value } : UNKNOWN;
      return UNKNOWN;
    }
    case "BinaryExpression": {
      const l = evalConst(fc, e.left, depth);
      const r = evalConst(fc, e.right, depth);
      if (l.kind === "bad" || r.kind === "bad") return BAD;
      if (l.kind !== "num" || r.kind !== "num") return UNKNOWN;
      const a = l.value;
      const b = r.value;
      let v: number;
      switch (e.operator) {
        case "+": v = a + b; break;
        case "-": v = a - b; break;
        case "*": v = a * b; break;
        case "/": if (b === 0) return UNKNOWN; v = a / b; break;
        case "div": if (b === 0) return UNKNOWN; v = Math.trunc(a / b); break;
        case "%": case "mod": if (b === 0) return UNKNOWN; v = a % b; break;
        case "<<": v = a * 2 ** b; break;
        case ">>": v = Math.floor(a / 2 ** b); break;
        case "&": v = a & b; break;
        case "|": v = a | b; break;
        case "^": v = a ^ b; break;
        default: return UNKNOWN;
      }
      return Number.isFinite(v) ? { kind: "num", value: v } : UNKNOWN;
    }
    case "Identifier": {
      if (depth >= MAX_MACRO_DEPTH) return UNKNOWN;
      // fc.resolve() treats EnumMember children as non-references, so resolve by name.
      const r = fc.resolveName(e.name, e);
      if (r.kind !== "macro" || r.declarations.length !== 1) return UNKNOWN;
      const decl = r.declarations[0]!;
      const body = decl.node.expression;
      if (!body) return UNKNOWN;
      return evalConst(fc.checker.forFile(decl.file), body, depth + 1);
    }
    default:
      return UNKNOWN;
  }
}

export const GM1003 = defineCheck({
  meta: {
    code: "GM1003",
    name: "enum-value-integer",
    description: "Enum assignment must be integer assignment.",
    category: "syntax",
    defaultSeverity: "error",
    preset: "syntax",
    feather: true,
    docs: docs("GM1003"),
  },
  create(ctx) {
    return {
      EnumMember(node) {
        if (!node.initializer) return;
        const v = evalConst(ctx.fc, node.initializer, 0);
        if (v.kind === "bad" || (v.kind === "num" && !Number.isInteger(v.value))) {
          ctx.report({ node: node.initializer, message: "Enum assignment must be integer assignment." });
        }
      },
    };
  },
});

export const GM1004 = defineCheck({
  meta: {
    code: "GM1004",
    name: "no-duplicate-enum-member",
    description: "The enum value has already been previously defined in the enum.",
    category: "syntax",
    defaultSeverity: "error",
    preset: "syntax",
    feather: true,
    docs: docs("GM1004"),
  },
  create(ctx) {
    return {
      EnumDeclaration(node) {
        const seen = new Set<string>();
        for (const m of node.members) {
          if (seen.has(m.id.name)) {
            ctx.report({
              node: m.id,
              message: `The enum value '${m.id.name}' has already been previously defined in the enum '${node.id.name}'.`,
            });
          }
          seen.add(m.id.name);
        }
      },
    };
  },
});

function related(message: string, file: SourceFile, node: AST.Node): RelatedLocation[] {
  return [{ message, file: file.path, range: node.range }];
}

export const GM1006 = defineCheck({
  meta: {
    code: "GM1006",
    name: "no-duplicate-enum",
    description: "The enum has already been previously declared.",
    category: "syntax",
    defaultSeverity: "error",
    preset: "syntax",
    feather: true,
    docs: docs("GM1006"),
  },
  create(ctx) {
    return {
      EnumDeclaration(node) {
        const decls = ctx.checker.binding.enums.get(node.id.name);
        if (!decls || decls.length < 2) return;
        const first = [...decls].sort(byLocation)[0]!;
        if (first.node === node) return;
        ctx.report({
          node: node.id,
          message: `The enum '${node.id.name}' has already been previously declared.`,
          related: related("First declared here.", first.file, first.node.id),
        });
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Macros
// ---------------------------------------------------------------------------

export const GM1038 = defineCheck({
  meta: {
    code: "GM1038",
    name: "no-duplicate-macro",
    description: "Macro with this name has been previously declared.",
    category: "syntax",
    defaultSeverity: "warning",
    preset: "recommended",
    feather: true,
    docs: docs("GM1038"),
  },
  create(ctx) {
    return {
      MacroDeclaration(node) {
        const decls = ctx.checker.binding.macros.get(node.id.name);
        if (!decls || decls.length < 2) return;
        const config = node.config?.name ?? null;
        const same = decls.filter((d) => (d.node.config?.name ?? null) === config).sort(byLocation);
        if (same.length < 2 || same[0]!.node === node) return;
        ctx.report({
          node: node.id,
          message: "Macro with this name has been previously declared.",
          related: related(`'${node.id.name}' first declared here.`, same[0]!.file, same[0]!.node.id),
        });
      },
    };
  },
});

/**
 * Offset just past the last code character of a macro body, skipping
 * comments (the lexer keeps them in the raw body) and string contents.
 */
function macroCodeEnd(text: string, node: AST.MacroDeclaration): number {
  const [start, end] = node.valueRange;
  let last = start;
  let i = start;
  while (i < end) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "/" && next === "/") break;
    if (ch === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 || close + 2 > end ? end : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || (ch === "@" && (next === '"' || next === "'"))) {
      const verbatim = ch === "@";
      const quote = verbatim ? next! : ch;
      let j = i + (verbatim ? 2 : 1);
      while (j < end && text[j] !== quote) j += !verbatim && text[j] === "\\" ? 2 : 1;
      i = Math.min(j + 1, end);
      last = i;
      continue;
    }
    i++;
    if (!/\s/.test(ch)) last = i;
  }
  return last;
}

export const GM1051 = defineCheck({
  meta: {
    code: "GM1051",
    name: "no-macro-semicolon",
    description: "Macro expressions should not be terminated with a ';' semicolon.",
    category: "syntax",
    defaultSeverity: "warning",
    preset: "recommended",
    feather: true,
    fixable: true,
    docs: docs("GM1051"),
  },
  create(ctx) {
    return {
      MacroDeclaration(node) {
        const end = macroCodeEnd(ctx.file.text, node);
        if (end <= node.valueRange[0] || ctx.file.text[end - 1] !== ";") return;
        // Strip the semicolon and the whitespace before it.
        let start = end - 1;
        while (start > node.valueRange[0] && / |\t/.test(ctx.file.text[start - 1]!)) start--;
        ctx.report({
          range: [end - 1, end],
          message: "Macro expressions should not be terminated with a ';' semicolon.",
          fix: { range: [start, end], text: "" },
        });
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Global functions and parameters
// ---------------------------------------------------------------------------

export const GM1064 = defineCheck({
  meta: {
    code: "GM1064",
    name: "no-duplicate-global-function",
    description: "Redeclaration of global function originally declared elsewhere.",
    category: "syntax",
    defaultSeverity: "warning",
    preset: "recommended",
    feather: true,
    docs: docs("GM1064"),
  },
  create(ctx) {
    return {
      FunctionDeclaration(node) {
        const infos = ctx.checker.binding.globalFunctions.get(node.id.name);
        if (!infos || infos.length < 2) return;
        const first = [...infos].sort(byLocation)[0]!;
        if (first.node === node || !infos.some((i) => i.node === node)) return;
        const where = first.file.gml?.owner ?? first.file.path;
        ctx.report({
          node: node.id,
          message: `Redeclaration of global function '${node.id.name}' originally declared in '${where}'.`,
          related: related("Original declaration.", first.file, first.node.id),
        });
      },
    };
  },
});

function checkParams(node: AST.FunctionLike, report: (p: AST.Parameter, kind: "dup" | "order") => void): void {
  const seen = new Set<string>();
  let optional = false;
  for (const p of node.params) {
    if (seen.has(p.id.name)) report(p, "dup");
    seen.add(p.id.name);
    if (p.init) optional = true;
    else if (optional) report(p, "order");
  }
}

export const GM1056 = defineCheck({
  meta: {
    code: "GM1056",
    name: "optional-parameters-last",
    description: "Bad practice to declare non-optional parameter after an optional parameter.",
    category: "style",
    defaultSeverity: "suggestion",
    preset: "recommended",
    feather: true,
    docs: docs("GM1056"),
  },
  create(ctx) {
    const check = (node: AST.FunctionLike) =>
      checkParams(node, (p, kind) => {
        if (kind === "order") ctx.report({ node: p, message: "Bad practice to declare non-optional parameter after an optional parameter." });
      });
    return { FunctionDeclaration: check, FunctionExpression: check };
  },
});

export const GM1059 = defineCheck({
  meta: {
    code: "GM1059",
    name: "no-duplicate-parameter",
    description: "The parameter has been previously declared.",
    category: "syntax",
    defaultSeverity: "warning",
    preset: "recommended",
    feather: true,
    docs: docs("GM1059"),
  },
  create(ctx) {
    const check = (node: AST.FunctionLike) =>
      checkParams(node, (p, kind) => {
        if (kind === "dup") ctx.report({ node: p.id, message: `The parameter '${p.id.name}' has been previously declared.` });
      });
    return { FunctionDeclaration: check, FunctionExpression: check };
  },
});

// ---------------------------------------------------------------------------
// argument / argumentN
// ---------------------------------------------------------------------------

type FunctionLikeScope = FunctionScope & { node: AST.FunctionLike };

/** Function scopes (not the file scope) of the file. */
function functionScopes(fc: FileChecker): FunctionLikeScope[] {
  return fc.scopes().filter((s): s is FunctionLikeScope => s.node.type !== "Program");
}

function firstRef(ids: AST.Identifier[]): AST.Identifier {
  return ids.reduce((a, b) => (b.range[0] < a.range[0] ? b : a));
}

export const GM1032 = defineCheck({
  meta: {
    code: "GM1032",
    name: "no-argument-gaps",
    description: "No references to some arguments but references a later argument.",
    category: "syntax",
    defaultSeverity: "warning",
    preset: "recommended",
    feather: true,
    docs: docs("GM1032"),
  },
  create(ctx) {
    return {
      Program() {
        for (const scope of functionScopes(ctx.fc)) {
          if (scope.argumentN.size === 0 || scope.usesArgumentArray) continue;
          const named = scope.node.params.length;
          const indices = [...scope.argumentN.keys()].sort((a, b) => a - b);
          let next = 0; // lowest index not yet accounted for
          for (const k of indices) {
            const missing: number[] = [];
            for (let j = Math.max(next, named); j < k; j++) if (!scope.argumentN.has(j)) missing.push(j);
            next = k + 1;
            if (missing.length === 0) continue;
            ctx.report({
              node: firstRef(scope.argumentN.get(k)!),
              message: `No references to argument${missing.length > 1 ? "s" : ""} ${missing.join(", ")} but references argument ${k}.`,
            });
          }
        }
      },
    };
  },
});

function isArgumentBuiltin(fc: FileChecker, id: AST.Identifier): boolean {
  if (id.name !== "argument" && !/^argument\d{1,2}$/.test(id.name)) return false;
  return fc.resolve(id)?.kind === "argument";
}

export const GM1034 = defineCheck({
  meta: {
    code: "GM1034",
    name: "no-argument-outside-function",
    description: "Argument cannot be referenced outside of script or function.",
    category: "syntax",
    defaultSeverity: "error",
    preset: "recommended",
    feather: true,
    docs: docs("GM1034"),
  },
  create(ctx) {
    // Legacy `#define` files are a list of scripts; their top level is a script body.
    if (ctx.file.ast.body.some((s) => s.type === "DefineDirective")) return {};
    // Fast path: the binder records file-scope argumentN / argument[...] uses.
    const root = ctx.fc.scopeOf(ctx.file.ast);
    if (root.argumentN.size === 0 && !root.usesArgumentArray) return {};
    return {
      Identifier(node) {
        if (!node.name.startsWith("argument") || node.name === "argument_count") return;
        if (!isArgumentBuiltin(ctx.fc, node)) return;
        if (ctx.fc.scopeOf(node).node.type !== "Program") return;
        ctx.report({ node, message: "Argument cannot be referenced outside of script or function." });
      },
    };
  },
});

export const GM1040 = defineCheck({
  meta: {
    code: "GM1040",
    name: "no-mixed-argument-styles",
    description: "argument# and argument[#] referencing cannot be mixed.",
    category: "syntax",
    defaultSeverity: "error",
    preset: "recommended",
    feather: true,
    docs: docs("GM1040"),
  },
  create(ctx) {
    return {
      Program() {
        for (const scope of functionScopes(ctx.fc)) {
          if (!scope.usesArgumentArray || scope.argumentN.size === 0) continue;
          const first = firstRef([...scope.argumentN.values()].flat());
          ctx.report({ node: first, message: "argument# and argument[#] referencing cannot be mixed." });
        }
      },
    };
  },
});

export const GM1055 = defineCheck({
  meta: {
    code: "GM1055",
    name: "no-argument-with-named-parameters",
    description: "Cannot mix argument# and named parameters.",
    category: "syntax",
    defaultSeverity: "warning",
    preset: "recommended",
    feather: true,
    docs: docs("GM1055"),
  },
  create(ctx) {
    return {
      Program() {
        for (const scope of functionScopes(ctx.fc)) {
          if (scope.argumentN.size === 0 || scope.node.params.length === 0) continue;
          const refs = [...scope.argumentN.values()].flat().sort((a, b) => a.range[0] - b.range[0]);
          for (const id of refs) {
            if (scope.locals.has(id.name)) continue; // a parameter/local literally named argumentN
            ctx.report({ node: id, message: "Cannot mix argument# and named parameters." });
          }
        }
      },
    };
  },
});

export const GM1036 = defineCheck({
  meta: {
    code: "GM1036",
    name: "invalid-array-index",
    description: "Array cannot be indexed in this way.",
    category: "syntax",
    defaultSeverity: "error",
    preset: "syntax",
    feather: true,
    docs: docs("GM1036"),
  },
  create(ctx) {
    return {
      IndexExpression(node) {
        if (node.indices.length === 0) {
          ctx.report({ node, message: "Array cannot be indexed in this way." });
          return;
        }
        if (node.accessor === "" && node.indices.length > 1 && node.object.type === "Identifier" && node.object.name === "argument") {
          if (ctx.fc.resolve(node.object)?.kind === "argument") ctx.report({ node, message: "Array cannot be indexed in this way." });
        }
      },
    };
  },
});

export const declarationChecks = [GM1002, GM1003, GM1004, GM1006, GM1032, GM1034, GM1036, GM1038, GM1040, GM1051, GM1055, GM1056, GM1059, GM1064];
