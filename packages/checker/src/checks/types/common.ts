/**
 * Helpers shared by the type checks. Every rule here follows one principle:
 * report only when the types involved are *definite* (fully inferred, no
 * unknown/any members) and *trustworthy* (no struct names that came from a
 * JSDoc name the checker could not resolve). Compatibility is more lenient
 * than `isAssignable` where GameMaker's runtime is (numeric handles, scripts
 * as functions, structs standing in for instances).
 */

import type * as AST from "@gml-lint/parser";
import type { Write } from "../../binder.js";
import type { Checker, FileChecker } from "../../checker.js";
import {
  isAssignable,
  isDefinite,
  normaliseConstantClass,
  T,
  typeCategory,
  typeToString,
  unionMembers,
  type Type,
  type TypeCategory,
} from "../../types.js";
import { FEATHER_DOCS, type CheckMeta } from "../api.js";
import { unparen } from "../util.js";

const docs = (code: string) => `${FEATHER_DOCS}#:~:text=${code}`;

export function typeMeta(code: string, name: string, description: string): CheckMeta {
  return { code, name, description, category: "type", feather: true, docs: docs(code) };
}

/** Struct names the checker actually knows (constructors, spec structures, `global`). */
export function isKnownStructName(checker: Checker, name: string): boolean {
  return name === "$global" || checker.binding.constructors.has(name) || !!checker.spec?.structures.has(name);
}

/** Definite, and every struct member names a known struct (or none). */
export function isSure(checker: Checker, t: Type): boolean {
  if (!isDefinite(t)) return false;
  return unionMembers(t).every((m) => m.kind !== "struct" || m.name === null || isKnownStructName(checker, m.name));
}

/** The definite type of an expression, or null when unsure. */
export function sureType(fc: FileChecker, e: AST.Expression | AST.AssignmentExpression): Type | null {
  const t = fc.typeOf(e);
  if (!isSure(fc.checker, t)) return null;
  if (e.type !== "AssignmentExpression" && unreliable(fc, e, 0)) return null;
  return t;
}

function macroValueKind(e: AST.Expression | null): string {
  if (!e) return "none";
  const u = unparen(e);
  if (u.type === "Literal") return u.kind === "string" || u.kind === "verbatim" ? "string" : u.kind === "undefined" ? "undefined" : u.kind === "boolean" ? "bool" : "number";
  if (u.type === "UnaryExpression" && u.operator === "-" && unparen(u.argument).type === "Literal") return "number";
  return `other:${u.type}`;
}

/**
 * Whether an expression's inferred type rests on information the flow-
 * insensitive inference is known to get wrong:
 *  - array/accessor reads: element writes (`a[i] = string(a[i])`) are not tracked
 *  - variables only ever assigned `undefined`: placeholders set somewhere the
 *    binder cannot see (statement macros, `variable_*_set`, other files)
 *  - variables also written through unidentified targets (`ps.name = v`)
 *  - `#macro NAME undefined` configuration placeholders
 * The answer follows locals and variables to the values assigned to them.
 */
const unreliableCache = new WeakMap<AST.Node, boolean>();
function unreliable(fc: FileChecker, expr: AST.Expression, depth: number): boolean {
  const e = unparen(expr);
  const hit = unreliableCache.get(e);
  if (hit !== undefined) return hit;
  if (depth > 6) return false;
  unreliableCache.set(e, false); // cycle guard
  const r = computeUnreliable(fc, e, depth);
  unreliableCache.set(e, r);
  return r;
}

function computeUnreliable(fc: FileChecker, e: AST.Expression, depth: number): boolean {
  const c = fc.checker;
  const writesUnreliable = (name: string, writes: Write[]): boolean => {
    if (c.binding.unknownTargetWrites.has(name)) return true;
    return writes.some((w) => w.value !== null && unreliable(c.forFile(w.file), w.value, depth + 1));
  };
  const placeholder = () => fc.typeOf(e).kind === "undefined";
  switch (e.type) {
    case "IndexExpression":
      return true;
    case "ConditionalExpression":
      return unreliable(fc, e.consequent, depth + 1) || unreliable(fc, e.alternate, depth + 1);
    case "LogicalExpression":
      return e.operator === "??" && (unreliable(fc, e.left, depth + 1) || unreliable(fc, e.right, depth + 1));
    case "Identifier": {
      const r = fc.resolve(e);
      if (!r) return false;
      switch (r.kind) {
        case "local": {
          if (r.symbol.kind === "parameter") return false; // typed by JSDoc or unknown
          if (placeholder()) return true;
          const sfc = c.forFile(r.symbol.scope.file);
          return r.symbol.values.some((v) => v !== null && unreliable(sfc, v, depth + 1));
        }
        case "macro": {
          // `#macro CFG undefined` is a placeholder; per-configuration macros
          // (`#macro Demo:CFG ...`) must agree on the kind of value.
          const kinds = new Set(r.declarations.map((d) => macroValueKind(d.node.expression)));
          return kinds.size > 1 || kinds.has("undefined");
        }
        case "instance-var":
        case "struct-field":
        case "global-var":
          return placeholder() || writesUnreliable(r.name, r.writes);
        default:
          return false;
      }
    }
    case "MemberExpression": {
      const m = fc.resolveMember(e);
      if (m.kind === "instance-var" || m.kind === "struct-field" || m.kind === "global-var") return placeholder() || writesUnreliable(m.name, m.writes);
      return false;
    }
    default:
      return false;
  }
}

export const show = (t: Type): string => typeToString(t);

/** Kinds that behave as numbers at runtime (handles included). */
export const NUMBERISH = new Set<Type["kind"]>(["real", "int64", "bool", "constant", "enum", "id", "asset", "instance"]);
const DS_IDS = new Set(["DsList", "DsMap", "DsGrid", "DsStack", "DsQueue", "DsPriority"]);

/**
 * Whether a value of `source` may be passed where `target` is expected,
 * erring on the side of "yes". Both should be definite.
 */
export function compatible(checker: Checker, source: Type, target: Type): boolean {
  if (!isDefinite(source) || !isDefinite(target)) return true;
  if (target.kind === "union") return target.types.some((t) => compatible(checker, source, t));
  if (source.kind === "union") return source.types.some((s) => compatible(checker, s, target));
  switch (target.kind) {
    case "real":
    case "int64":
    case "bool":
    case "constant":
    case "enum":
      return NUMBERISH.has(source.kind);
    case "id":
      if (source.kind === "id") return source.sub === target.sub || !(DS_IDS.has(source.sub) && DS_IDS.has(target.sub));
      return source.kind === "real" || source.kind === "int64" || source.kind === "constant";
    case "instance":
      return isAssignable(source, target) || source.kind === "struct" || source.kind === "int64" || source.kind === "enum";
    case "asset":
      if (source.kind === "function") return target.sub === "GMScript" || target.sub === null;
      return isAssignable(source, target) || source.kind === "enum" || source.kind === "constant";
    case "function":
      // Legacy code passes script indices as numbers.
      return source.kind === "function" || source.kind === "real" || source.kind === "int64" || (source.kind === "asset" && (source.sub === "GMScript" || source.sub === null));
    case "struct":
      if (target.name !== null && !isKnownStructName(checker, target.name)) return true;
      if (source.kind === "instance") return true;
      if (source.kind !== "struct") return false;
      if (target.name === null || source.name === null || source.name === target.name) return true;
      if (source.name === "$global") return false;
      return checker.constructorChain(source.name).some((c) => c.name === target.name) || !checker.binding.constructors.has(source.name);
    case "pointer":
      return source.kind === "pointer" || source.kind === "undefined" || source.kind === "real" || source.kind === "int64";
    case "array":
      return source.kind === "array" && compatible(checker, source.element, target.element);
    default:
      return isAssignable(source, target);
  }
}

/** The single category of all members (ignoring Undefined), or null when mixed/unclassifiable. */
export function soleCategory(t: Type): TypeCategory | null {
  let cat: TypeCategory | null = null;
  for (const m of unionMembers(t)) {
    const c = typeCategory(m);
    if (c === null) return null;
    if (c === "undefined") continue;
    if (cat !== null && cat !== c) return null;
    cat = c;
  }
  return cat;
}

/** Strips Undefined members (returns Undefined when nothing else is left). */
export function withoutUndefined(t: Type): Type {
  if (t.kind !== "union") return t;
  const rest = t.types.filter((m) => m.kind !== "undefined");
  if (rest.length === 0) return T.undefined;
  return rest.length === 1 ? rest[0]! : { kind: "union", types: rest };
}

/**
 * The built-in constant group of an expression (`fa_readonly` -> "FileAttribute"),
 * following macros whose body is a single constant. Null for class-less
 * constants (`pi`) and anything else.
 */
export function constantClassOf(fc: FileChecker, expr: AST.Expression): string | null {
  const e = unparen(expr);
  if (e.type !== "Identifier") return null;
  const r = fc.resolve(e);
  if (r?.kind === "builtin-constant") return groupOf(r.spec.class, r.spec.type);
  if (r?.kind === "macro" && r.declarations.length === 1) {
    const d = r.declarations[0]!;
    const body = d.node.expression ? unparen(d.node.expression) : null;
    if (body?.type === "Identifier") {
      const inner = fc.checker.forFile(d.file).resolveName(body.name, d.node);
      if (inner.kind === "builtin-constant") return groupOf(inner.spec.class, inner.spec.type);
    }
  }
  return null;
}

/** Constant classes that are plain numbers rather than groups (`Math`: `pi`, ...). */
const NON_GROUP_CLASSES = new Set(["Math"]);

function groupOf(cls: string | null, type: string): string | null {
  const c = cls ?? /^Constant\.(\w+)$/.exec(type)?.[1] ?? null;
  return c && !NON_GROUP_CLASSES.has(c) ? c : null;
}

/** Constants of each (normalised) class, for GM1044 messages. */
const groupCache = new WeakMap<object, Map<string, string[]>>();
export function constantsOfClass(checker: Checker, cls: string): string[] {
  const spec = checker.spec;
  if (!spec) return [];
  let m = groupCache.get(spec);
  if (!m) {
    m = new Map();
    for (const c of spec.constants.values()) {
      if (!c.class || c.deprecated) continue;
      const key = normaliseConstantClass(c.class);
      let list = m.get(key);
      if (!list) m.set(key, (list = []));
      list.push(c.name);
    }
    groupCache.set(spec, m);
  }
  return m.get(normaliseConstantClass(cls)) ?? [];
}

/** Known `Constant.*` class names (normalised), from constants and type strings in the spec. */
const classCache = new WeakMap<object, Set<string>>();
export function knownConstantClasses(checker: Checker): Set<string> | null {
  const spec = checker.spec;
  if (!spec || spec.constants.size === 0) return null;
  let s = classCache.get(spec);
  if (!s) {
    s = new Set();
    const add = (text: string) => {
      for (const m of text.matchAll(/Constant\.(\w+)/g)) s!.add(normaliseConstantClass(m[1]!));
    };
    for (const c of spec.constants.values()) {
      if (c.class) s.add(normaliseConstantClass(c.class));
      add(c.type);
    }
    for (const f of spec.functions.values()) {
      add(f.returnType);
      for (const p of f.parameters) add(p.type);
    }
    for (const v of spec.variables.values()) add(v.type);
    classCache.set(spec, s);
  }
  return s;
}

export function scopeOfFunction(fc: FileChecker, node: AST.FunctionLike) {
  return fc.binding.scopes.get(node) ?? null;
}

/** Whether a node was produced by a statement macro expansion (its range is not real code). */
export function fromMacro(node: AST.Node): boolean {
  return node.fromMacro !== undefined;
}
