/**
 * GM2017: naming conventions (Feather's Naming Rules). Off unless the "all"
 * preset is used or the rule is enabled explicitly.
 */

import type * as AST from "@gml-lint/parser";
import { defineCheck } from "../api.js";
import { docs, firstWrite } from "./shared.js";

type NamingStyle = "unconstrained" | "UpperCamelCase" | "lowerCamelCase" | "ALL_UPPER" | "all_lower";

interface NamingRule {
  style?: NamingStyle;
  prefix?: string;
  suffix?: string;
  /** Regular expression the whole name must match (overrides `style` for checking; `style` is still used for the suggestion). */
  pattern?: string;
}

type NamingKind =
  | "localVariable"
  | "parameter"
  | "instanceVariable"
  | "function"
  | "constructor"
  | "macro"
  | "enum"
  | "enumMember";

const UPPER_OR_PASCAL = "^_*(?:[A-Z][A-Z0-9_]*|[A-Z][A-Za-z0-9]*)_*$";

/** Defaults follow Feather's documented example (`_s`, `spr_sprite`, `SIZE.SMALL`, `show()`). */
const DEFAULT_NAMING_RULES: Readonly<Record<NamingKind, NamingRule>> = {
  localVariable: { style: "all_lower", prefix: "_" },
  parameter: { style: "all_lower" },
  instanceVariable: { style: "all_lower" },
  function: { style: "all_lower" },
  constructor: { style: "UpperCamelCase" },
  macro: { style: "ALL_UPPER" },
  enum: { style: "ALL_UPPER", pattern: UPPER_OR_PASCAL },
  enumMember: { style: "ALL_UPPER", pattern: UPPER_OR_PASCAL },
};

const STYLES: ReadonlySet<string> = new Set(["unconstrained", "UpperCamelCase", "lowerCamelCase", "ALL_UPPER", "all_lower"]);

const LABELS: Readonly<Record<NamingKind, string>> = {
  localVariable: "local variable",
  parameter: "parameter",
  instanceVariable: "instance variable",
  function: "function",
  constructor: "constructor",
  macro: "macro",
  enum: "enum",
  enumMember: "enum member",
};

function styleMatches(core: string, style: NamingStyle): boolean {
  if (core === "") return true;
  switch (style) {
    case "all_lower":
      return /^[a-z0-9_]+$/.test(core);
    case "ALL_UPPER":
      return /^[A-Z0-9_]+$/.test(core);
    case "UpperCamelCase":
      return /^[A-Z][A-Za-z0-9]*$/.test(core);
    case "lowerCamelCase":
      return /^[a-z][A-Za-z0-9]*$/.test(core);
    default:
      return true;
  }
}

function words(core: string): string[] {
  return core
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[_\s]+/)
    .filter((w) => w.length > 0);
}

const cap = (w: string) => w[0]!.toUpperCase() + w.slice(1).toLowerCase();

function applyStyle(core: string, style: NamingStyle): string {
  const ws = words(core);
  if (ws.length === 0) return core;
  switch (style) {
    case "all_lower":
      return ws.map((w) => w.toLowerCase()).join("_");
    case "ALL_UPPER":
      return ws.map((w) => w.toUpperCase()).join("_");
    case "UpperCamelCase":
      return ws.map(cap).join("");
    case "lowerCamelCase":
      return ws.map((w, i) => (i === 0 ? w.toLowerCase() : cap(w))).join("");
    default:
      return core;
  }
}

/**
 * Checks `name` against `rule`. The name is split into prefix, leading
 * underscores, core, trailing underscores and suffix; only the core is
 * restyled in the suggestion.
 */
function analyse(name: string, rule: NamingRule): { ok: boolean; recommended: string | null } {
  const prefix = rule.prefix ?? "";
  const suffix = rule.suffix ?? "";
  let rest = name;
  const hasPrefix = rest.startsWith(prefix);
  if (hasPrefix) rest = rest.slice(prefix.length);
  const hasSuffix = rest.endsWith(suffix) && rest.length >= suffix.length;
  if (hasSuffix && suffix) rest = rest.slice(0, rest.length - suffix.length);
  const lead = /^_*/.exec(rest)![0];
  rest = rest.slice(lead.length);
  const trail = /_*$/.exec(rest)![0];
  const core = rest.slice(0, rest.length - trail.length);
  const style = rule.style ?? "unconstrained";
  const ok = rule.pattern !== undefined ? new RegExp(rule.pattern).test(name) : hasPrefix && hasSuffix && styleMatches(core, style);
  if (ok) return { ok, recommended: null };
  const recommended = rule.style !== undefined || rule.pattern === undefined ? prefix + lead + applyStyle(core, style) + trail + suffix : null;
  return { ok, recommended: recommended === name ? null : recommended };
}

function ruleFrom(value: unknown, fallback: NamingRule): NamingRule {
  if (typeof value === "string") return STYLES.has(value) ? { style: value as NamingStyle } : { pattern: value };
  if (value && typeof value === "object") return value as NamingRule;
  return fallback;
}

export const GM2017 = defineCheck({
  meta: {
    code: "GM2017",
    name: "naming-convention",
    description:
      "Inconsistent naming. Options per kind (localVariable, parameter, instanceVariable, function, constructor, macro, enum, enumMember): " +
      "a style ('all_lower', 'ALL_UPPER', 'UpperCamelCase', 'lowerCamelCase', 'unconstrained'), a regex string, or { style, prefix, suffix, pattern }; " +
      "`ignore` lists exempt names. Defaults: locals _all_lower, parameters/instance variables/functions all_lower, constructors UpperCamelCase, " +
      "macros ALL_UPPER, enums and members ALL_UPPER or UpperCamelCase. Leading/trailing underscores are preserved.",
    category: "style",
    feather: true,
    docs: docs("GM2017"),
  },
  create(ctx) {
    const o = ctx.options;
    const rules = {} as Record<NamingKind, NamingRule>;
    for (const k of Object.keys(DEFAULT_NAMING_RULES) as NamingKind[]) rules[k] = ruleFrom(o[k], DEFAULT_NAMING_RULES[k]);
    const ignore = new Set(Array.isArray(o["ignore"]) ? o["ignore"].map(String) : []);

    const check = (id: AST.Node, name: string, kind: NamingKind) => {
      if (ignore.has(name) || id.fromMacro) return;
      const { ok, recommended } = analyse(name, rules[kind]);
      if (ok) return;
      ctx.report({
        node: id,
        message: recommended
          ? `Inconsistent naming. Recommended name is '${recommended}'.`
          : `Inconsistent naming. '${name}' does not match the ${LABELS[kind]} naming rule.`,
      });
    };

    const gml = ctx.file.gml;
    const c = ctx.checker;
    return {
      VariableDeclaration(node) {
        if (node.kind !== "var") return;
        for (const d of node.declarations) {
          if (ctx.fc.scopeOf(d).locals.get(d.id.name)?.declarations[0] === d.id) check(d.id, d.id.name, "localVariable");
        }
      },
      Parameter(node) {
        check(node.id, node.id.name, "parameter");
      },
      FunctionDeclaration(node) {
        const isCtor = ctx.fc.binding.scopes.get(node)?.isConstructor ?? node.isConstructor;
        check(node.id, node.id.name, isCtor ? "constructor" : "function");
      },
      MacroDeclaration(node) {
        check(node.id, node.id.name, "macro");
      },
      EnumDeclaration(node) {
        check(node.id, node.id.name, "enum");
        for (const m of node.members) check(m.id, m.id.name, "enumMember");
      },
      Program() {
        // Instance variables: once per object, at the first write in its own events.
        if (gml?.kind !== "event") return;
        const vars = c.binding.objectVars.get(gml.owner);
        if (!vars) return;
        for (const [name, writes] of vars) {
          if (c.spec?.variables.has(name)) continue;
          const first = firstWrite(writes.filter((w) => w.direct && w.file.gml?.kind === "event" && w.file.gml.owner === gml.owner));
          if (!first || first.file !== ctx.file || first.nameNode.type !== "Identifier") continue;
          if (c.objectChain(gml.owner).slice(1).some((a) => c.binding.objectVars.get(a)?.has(name))) continue; // the parent's name
          if (ctx.fc.resolveName(name, first.nameNode).kind !== "instance-var") continue;
          check(first.nameNode, name, "instanceVariable");
        }
      },
    };
  },
});
