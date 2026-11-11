/**
 * Resolves identifiers and infers types, lazily and with caching, on top of
 * the Binder's tables. Checks, the CLI and the ESLint plugin all query it.
 */

import type * as AST from "@gml-lint/parser";
import type { Project, Resource, RoomInstance } from "@gml-lint/project";
import type { GmlSpec, SpecConstant, SpecEnumeration, SpecFunction, SpecVariable } from "./spec/index.js";
import {
  bind,
  type Binding,
  type ConstructorInfo,
  type Declaration,
  type FileBinding,
  type FunctionScope,
  type GlobalFunctionInfo,
  type LocalSymbol,
  type SelfContext,
  type Write,
  GLOBAL_SELF,
  UNKNOWN_SELF,
} from "./binder.js";
import type { Program, SourceFile } from "./program.js";
import {
  ASSET_SUBTYPE,
  isUnknown,
  parseType,
  T,
  union,
  unionMembers,
  type Parameter,
  type Signature,
  type Type,
} from "./types.js";

export type Resolution =
  | { kind: "local"; symbol: LocalSymbol }
  | { kind: "macro"; declarations: Array<Declaration<AST.MacroDeclaration>> }
  | { kind: "enum"; name: string; declarations: Array<Declaration<AST.EnumDeclaration>> }
  | { kind: "builtin-enum"; spec: SpecEnumeration }
  | { kind: "keyword"; name: "self" | "other" | "global" | "all" | "noone" }
  | { kind: "argument"; index: number | null }
  | { kind: "builtin-variable"; spec: SpecVariable }
  | { kind: "builtin-constant"; spec: SpecConstant }
  | { kind: "builtin-function"; spec: SpecFunction }
  | { kind: "global-function"; info: GlobalFunctionInfo; all: GlobalFunctionInfo[] }
  | { kind: "script"; resource: Resource }
  | { kind: "asset"; resource: Resource }
  | { kind: "room-instance"; room: string; instance: RoomInstance }
  | { kind: "extension-function"; name: string; minArgs: number; maxArgs: number }
  | { kind: "extension-constant"; name: string }
  | { kind: "globalvar"; name: string }
  | { kind: "global-var"; name: string; writes: Write[] }
  | { kind: "instance-var"; object: string; name: string; writes: Write[] }
  | { kind: "struct-field"; ctor: string; name: string; writes: Write[] }
  | { kind: "struct-literal-field"; name: string }
  | { kind: "self-member"; self: SelfContext; name: string };

export type MemberResolution =
  | { kind: "instance-var"; object: string; name: string; writes: Write[] }
  | { kind: "builtin-variable"; spec: SpecVariable }
  | { kind: "struct-field"; ctor: string; name: string; writes: Write[] }
  | { kind: "global-var"; name: string; writes: Write[] }
  | { kind: "enum-member"; enumName: string; member: AST.EnumMember | null }
  | { kind: "undeclared"; owner: "object" | "struct" | "global" | "enum"; ownerName: string; name: string }
  | { kind: "unknown" };

const KEYWORD_IDENTIFIERS = new Set(["self", "other", "global", "all", "noone"]);

interface ExtensionTables {
  functions: Map<string, { min: number; max: number }>;
  constants: Set<string>;
}

export class Checker {
  readonly program: Program;
  readonly project: Project | null;
  readonly spec: GmlSpec | null;
  readonly binding: Binding;
  private readonly fileCheckers = new Map<string, FileChecker>();
  /** Variable and return types, keyed by `obj:`, `ctor:`, `global:` and `return:` keys. */
  private readonly typeCache = new Map<string, Type>();
  private readonly inProgress = new Set<string>();
  private roomInstances: Map<string, { room: string; instance: RoomInstance }> | null = null;
  private extensions: ExtensionTables | null = null;
  private readonly signatureCache = new WeakMap<object, Signature>();

  constructor(program: Program) {
    this.program = program;
    this.project = program.project;
    this.spec = program.spec;
    this.binding = bind(program.getSourceFiles(), program.project);
  }

  forFile(file: SourceFile | string): FileChecker {
    const path = typeof file === "string" ? file : file.path;
    let fc = this.fileCheckers.get(path);
    if (!fc) {
      const fb = this.binding.files.get(path);
      if (!fb) throw new Error(`File not in program: ${path}`);
      fc = new FileChecker(this, fb);
      this.fileCheckers.set(path, fc);
    }
    return fc;
  }

  // -------------------------------------------------------------------------
  // Project-level lookups
  // -------------------------------------------------------------------------

  isObject(name: string): boolean {
    return !!this.project?.objects.has(name);
  }

  /** The object and its ancestors, nearest first. */
  objectChain(name: string): string[] {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: string | null = name;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = this.project?.objects.get(cur)?.parent ?? null;
    }
    return chain;
  }

  /** Writes declaring `name` on `object` or its ancestors. */
  objectVarWrites(object: string, name: string): Write[] | null {
    let found: Write[] | null = null;
    for (const o of this.objectChain(object)) {
      const w = this.binding.objectVars.get(o)?.get(name);
      if (w) found = found ? found.concat(w) : w;
    }
    return found;
  }

  /** Whether `object` or an ancestor has writes with computed names, so its variable set is not known. */
  objectIsDynamic(object: string): boolean {
    // Computed-name writes through unknown targets (`variable_instance_set(inst, name, v)`
    // in some library) are not considered: they would silence every object.
    for (const o of this.objectChain(object)) if (this.binding.dynamicObjects.has(o)) return true;
    return false;
  }

  builtinInstanceVariable(name: string): SpecVariable | undefined {
    const v = this.spec?.variables.get(name);
    return v && v.instance ? v : undefined;
  }

  constructorChain(name: string): ConstructorInfo[] {
    const out: ConstructorInfo[] = [];
    const seen = new Set<string>();
    let cur: string | null = name;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const info = this.binding.constructors.get(cur);
      if (!info) break;
      out.push(info);
      cur = info.parent;
    }
    return out;
  }

  constructorFieldWrites(ctor: string, name: string): Write[] | null {
    let found: Write[] | null = null;
    for (const c of this.constructorChain(ctor)) {
      const w = c.fields.get(name) ?? c.statics.get(name);
      if (w) found = found ? found.concat(w) : w;
    }
    return found;
  }

  roomInstance(name: string): { room: string; instance: RoomInstance } | undefined {
    if (!this.roomInstances) {
      this.roomInstances = new Map();
      for (const room of this.project?.rooms.values() ?? []) {
        for (const inst of room.instances) this.roomInstances.set(inst.name, { room: room.name, instance: inst });
      }
    }
    return this.roomInstances.get(name);
  }

  /**
   * Argument bounds of an extension function. The .yy `argCount` is not
   * reliable (0 with three `args`, 1 with none), so the bounds span `argCount`,
   * `args.length` and the parameter count in `help` ("name(a,b,c)").
   */
  extensionFunction(name: string): { min: number; max: number } | undefined {
    return this.loadExtensions().functions.get(name);
  }

  isExtensionConstant(name: string): boolean {
    return this.loadExtensions().constants.has(name);
  }

  private loadExtensions(): ExtensionTables {
    if (this.extensions) return this.extensions;
    const functions = new Map<string, { min: number; max: number }>();
    const constants = new Set<string>();
    for (const ext of this.project?.extensions.values() ?? []) {
      for (const f of ext.functions) {
        if (f.argCount < 0) {
          functions.set(f.name, { min: 0, max: Infinity });
          continue;
        }
        const counts = [f.argCount, f.args.length];
        const help = /\(([^)]*)\)/.exec(f.help);
        if (help) counts.push(help[1]!.trim() === "" ? 0 : help[1]!.split(",").length);
        if (help && /\.\.\./.test(help[1]!)) counts.push(Infinity);
        functions.set(f.name, { min: Math.min(...counts), max: Math.max(...counts) });
      }
      for (const c of ext.constants) constants.add(c.name);
    }
    this.extensions = { functions, constants };
    return this.extensions;
  }

  // -------------------------------------------------------------------------
  // Signatures
  // -------------------------------------------------------------------------

  builtinSignature(spec: SpecFunction): Signature {
    const cached = this.signatureCache.get(spec);
    if (cached) return cached;
    const sig: Signature = {
      parameters: spec.parameters.map((p) => ({ name: p.name, type: parseType(p.type), optional: p.optional, rest: p.rest })),
      returnType: parseType(spec.returnType),
      minArgs: spec.minArgs,
      maxArgs: spec.maxArgs,
      pure: spec.pure,
      deprecated: spec.deprecated,
    };
    this.signatureCache.set(spec, sig);
    return sig;
  }

  /** Signature of a user-defined function from its scope (parameters + JSDoc). */
  scopeSignature(scope: FunctionScope): Signature {
    const cached = this.signatureCache.get(scope);
    if (cached) return cached;
    const node = scope.node as AST.FunctionLike;
    const doc = scope.doc;
    const params: Parameter[] = node.params.map((p) => {
      const d = doc?.params.find((dp) => dp.name === p.id.name);
      return {
        name: p.id.name,
        type: d?.type ?? T.unknown,
        optional: p.init !== null || (d?.optional ?? false),
        rest: false,
      };
    });
    let minArgs = 0;
    for (const p of params) {
      if (p.optional) break;
      minArgs++;
    }
    let maxArgs = params.length;
    if (scope.usesArgumentArray || scope.usesArgumentCount) {
      maxArgs = Infinity;
      if (params.length === 0) minArgs = 0;
    } else if (params.length === 0 && scope.argumentN.size > 0) {
      const highest = Math.max(...scope.argumentN.keys());
      minArgs = highest + 1;
      maxArgs = highest + 1;
    }
    const sig: Signature = {
      parameters: params,
      returnType: T.unknown, // filled lazily by returnTypeOf
      minArgs,
      maxArgs,
      pure: doc?.pure ?? false,
      deprecated: doc?.deprecated ?? false,
    };
    this.signatureCache.set(scope, sig);
    return sig;
  }

  returnTypeOf(scope: FunctionScope): Type {
    const key = `return:${scope.file.path}:${scope.node.range[0]}`;
    const cached = this.typeCache.get(key);
    if (cached) return cached;
    if (scope.doc?.returns?.type) {
      this.typeCache.set(key, scope.doc.returns.type);
      return scope.doc.returns.type;
    }
    if ((scope.node as AST.FunctionLike).isConstructor) return { kind: "struct", name: scope.name };
    if (this.inProgress.has(key)) return T.unknown;
    this.inProgress.add(key);
    const fc = this.forFile(scope.file);
    const types: Type[] = [];
    for (const r of scope.returns) types.push(r.argument ? fc.typeOf(r.argument) : T.undefined);
    this.inProgress.delete(key);
    const t = types.length === 0 ? T.undefined : union(types);
    this.typeCache.set(key, t);
    return t;
  }

  // -------------------------------------------------------------------------
  // Variable types
  // -------------------------------------------------------------------------

  typeOfWrites(key: string, writes: Write[]): Type {
    const cached = this.typeCache.get(key);
    if (cached) return cached;
    if (this.inProgress.has(key)) return T.unknown;
    this.inProgress.add(key);
    const types: Type[] = [];
    for (const w of writes) {
      if (w.node.type === "FunctionDeclaration") {
        const fc = this.forFile(w.file);
        types.push(fc.typeOfFunctionNode(w.node));
        continue;
      }
      if (!w.value) {
        types.push(T.unknown);
        continue;
      }
      types.push(this.forFile(w.file).typeOf(w.value));
    }
    this.inProgress.delete(key);
    const t = types.length ? union(types) : T.unknown;
    this.typeCache.set(key, t);
    return t;
  }

  objectVarType(object: string, name: string): Type {
    const builtin = this.builtinInstanceVariable(name);
    if (builtin) return parseType(builtin.type);
    const writes = this.objectVarWrites(object, name);
    if (!writes || writes.length === 0) return T.unknown;
    return this.typeOfWrites(`obj:${object}.${name}`, writes);
  }

  structFieldType(ctor: string, name: string): Type {
    const writes = this.constructorFieldWrites(ctor, name);
    if (!writes || writes.length === 0) return T.unknown;
    return this.typeOfWrites(`ctor:${ctor}.${name}`, writes);
  }

  globalVarType(name: string): Type {
    const writes = this.binding.globals.get(name);
    if (!writes || writes.length === 0) return T.unknown;
    return this.typeOfWrites(`global:${name}`, writes);
  }

  selfType(self: SelfContext): Type {
    switch (self.kind) {
      case "object":
        return T.instance(self.object);
      case "struct":
        return { kind: "struct", name: self.ctor };
      case "global":
        return { kind: "struct", name: "$global" };
      default:
        return T.unknown;
    }
  }

  /** Converts a value type to the `self` context it designates (for `with`). */
  contextOfType(t: Type): SelfContext {
    if (t.kind === "instance" && t.object) return { kind: "object", object: t.object };
    if (t.kind === "asset" && t.sub === "GMObject") return UNKNOWN_SELF;
    if (t.kind === "struct") return t.name === "$global" ? GLOBAL_SELF : { kind: "struct", ctor: t.name, node: null };
    return UNKNOWN_SELF;
  }
}

/** Per-file queries. */
export class FileChecker {
  readonly checker: Checker;
  readonly binding: FileBinding;
  readonly file: SourceFile;
  private readonly types = new WeakMap<AST.Node, Type>();
  private readonly resolutions = new WeakMap<AST.Identifier, Resolution | null>();
  private readonly withSelfCache = new WeakMap<AST.WithStatement, SelfContext>();
  private readonly busy = new WeakSet<AST.Node>();
  private readonly scopeSignatures = new WeakMap<FunctionScope, Signature>();

  constructor(checker: Checker, binding: FileBinding) {
    this.checker = checker;
    this.binding = binding;
    this.file = binding.file;
  }

  parent(node: AST.Node): AST.Node | null {
    return this.binding.parents.get(node) ?? null;
  }

  ancestors(node: AST.Node): AST.Node[] {
    const out: AST.Node[] = [];
    let p = this.parent(node);
    while (p) {
      out.push(p);
      p = this.parent(p);
    }
    return out;
  }

  /** The function scope (or file scope) a node belongs to. */
  scopeOf(node: AST.Node): FunctionScope {
    let cur: AST.Node | null = node;
    let prev: AST.Node | null = null;
    while (cur) {
      if ((cur.type === "FunctionDeclaration" || cur.type === "FunctionExpression") && prev !== null && prev !== cur.id) {
        const s = this.binding.scopes.get(cur);
        if (s) return s;
      }
      if (cur.type === "Program") return this.binding.root;
      prev = cur;
      cur = this.parent(cur);
    }
    return this.binding.root;
  }

  /** Every function scope in this file, file scope first. */
  scopes(): FunctionScope[] {
    return [...this.binding.scopes.values()];
  }

  /** `self` at a node, taking enclosing `with` statements into account. */
  selfAt(node: AST.Node): SelfContext {
    let cur: AST.Node | null = node;
    let prev: AST.Node | null = null;
    while (cur) {
      if (cur.type === "WithStatement" && prev === cur.body) return this.withSelf(cur);
      if ((cur.type === "FunctionDeclaration" || cur.type === "FunctionExpression") && prev === cur.body) {
        return this.binding.scopes.get(cur)?.self ?? UNKNOWN_SELF;
      }
      if (cur.type === "Program") return this.binding.root.self;
      prev = cur;
      cur = this.parent(cur);
    }
    return this.binding.root.self;
  }

  /** `other` at a node. */
  otherAt(node: AST.Node): SelfContext {
    let cur: AST.Node | null = node;
    let prev: AST.Node | null = null;
    while (cur) {
      if (cur.type === "WithStatement" && prev === cur.body) return this.selfAt(cur);
      if ((cur.type === "FunctionDeclaration" || cur.type === "FunctionExpression") && prev === cur.body) {
        return this.binding.scopes.get(cur)?.other ?? UNKNOWN_SELF;
      }
      if (cur.type === "Program") return this.binding.root.other;
      prev = cur;
      cur = this.parent(cur);
    }
    return this.binding.root.other;
  }

  withSelf(node: AST.WithStatement): SelfContext {
    const cached = this.withSelfCache.get(node);
    if (cached) return cached;
    const ctx = this.contextOfExpression(node.object);
    this.withSelfCache.set(node, ctx);
    return ctx;
  }

  /** Whether the identifier is in a position that references a value (not a declaration name or property key). */
  isReference(id: AST.Identifier): boolean {
    const p = this.parent(id);
    if (!p) return true;
    switch (p.type) {
      case "MemberExpression":
        return p.object === id;
      case "StructProperty":
        return p.value === id || (p.value === null && p.key === id);
      case "VariableDeclarator":
        return p.init === id;
      case "Parameter":
        return p.init === id;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "EnumDeclaration":
      case "MacroDeclaration":
      case "CatchClause":
        return false;
      case "EnumMember":
        return p.initializer === id;
      default:
        return true;
    }
  }

  // -------------------------------------------------------------------------
  // Name resolution
  // -------------------------------------------------------------------------

  /** Resolves an identifier in reference position. Returns null for non-reference positions. */
  resolve(id: AST.Identifier): Resolution | null {
    if (this.resolutions.has(id)) return this.resolutions.get(id)!;
    const r = this.isReference(id) ? this.resolveName(id.name, id) : null;
    this.resolutions.set(id, r);
    return r;
  }

  /** Resolves a bare name as if written at `at`. */
  resolveName(name: string, at: AST.Node): Resolution {
    const c = this.checker;
    const b = c.binding;

    const macros = b.macros.get(name);
    if (macros) return { kind: "macro", declarations: macros };
    const enums = b.enums.get(name);
    if (enums) return { kind: "enum", name, declarations: enums };

    const scope = this.scopeOf(at);
    const local = scope.locals.get(name);
    if (local && (local.kind !== "local" || local.declarations[0]!.range[0] <= at.range[0])) {
      return { kind: "local", symbol: local };
    }

    if (KEYWORD_IDENTIFIERS.has(name)) return { kind: "keyword", name: name as "self" };
    if (name === "argument" || name === "argument_count") return { kind: "argument", index: null };
    const argN = /^argument(\d{1,2})$/.exec(name);
    if (argN) return { kind: "argument", index: Number(argN[1]) };

    const spec = c.spec;
    if (spec) {
      const v = spec.variables.get(name);
      if (v) return { kind: "builtin-variable", spec: v };
      const k = spec.constants.get(name);
      if (k) return { kind: "builtin-constant", spec: k };
      const f = spec.functions.get(name);
      if (f) return { kind: "builtin-function", spec: f };
      const e = spec.enumerations.get(name);
      if (e) return { kind: "builtin-enum", spec: e };
    }

    const fns = b.globalFunctions.get(name);
    if (fns && fns.length) return { kind: "global-function", info: fns[0]!, all: fns };

    // Notes and extensions are not addressable from GML by name.
    const res = c.project?.resources.get(name);
    if (res && res.type !== "note" && res.type !== "extension") {
      return res.type === "script" ? { kind: "script", resource: res } : { kind: "asset", resource: res };
    }

    const inst = c.roomInstance(name);
    if (inst) return { kind: "room-instance", room: inst.room, instance: inst.instance };

    const ext = c.extensionFunction(name);
    if (ext !== undefined) return { kind: "extension-function", name, minArgs: ext.min, maxArgs: ext.max };
    if (c.isExtensionConstant(name)) return { kind: "extension-constant", name };

    if (b.globalvars.has(name)) return { kind: "globalvar", name };

    const self = this.selfAt(at);
    if (self.kind === "object") {
      const writes = c.objectVarWrites(self.object, name);
      if (writes) return { kind: "instance-var", object: self.object, name, writes };
    } else if (self.kind === "struct") {
      if (self.ctor) {
        const writes = c.constructorFieldWrites(self.ctor, name);
        if (writes) return { kind: "struct-field", ctor: self.ctor, name, writes };
      } else if (self.node?.type === "StructExpression") {
        if (self.node.properties.some((p) => (p.key.type === "Identifier" ? p.key.name : p.key.value) === name)) {
          return { kind: "struct-literal-field", name };
        }
      }
    } else if (self.kind === "global") {
      const writes = b.globals.get(name);
      if (writes) return { kind: "global-var", name, writes };
    }
    return { kind: "self-member", self, name };
  }

  /** Resolves `object.property`. */
  resolveMember(node: AST.MemberExpression): MemberResolution {
    const c = this.checker;
    const name = node.property.name;
    const obj = node.object;
    if (obj.type === "Identifier") {
      const r = this.resolve(obj);
      if (r?.kind === "enum") {
        const decl = r.declarations[0]!.node;
        const member = decl.members.find((m) => m.id.name === name) ?? null;
        if (!member && r.declarations.every((d) => !d.node.members.some((m) => m.id.name === name))) {
          return { kind: "undeclared", owner: "enum", ownerName: r.name, name };
        }
        return { kind: "enum-member", enumName: r.name, member };
      }
      if (r?.kind === "builtin-enum") {
        if (!r.spec.members.some((m) => m.name === name)) return { kind: "undeclared", owner: "enum", ownerName: r.spec.name, name };
        return { kind: "enum-member", enumName: r.spec.name, member: null };
      }
      if (r?.kind === "keyword" && r.name === "global") {
        const writes = c.binding.globals.get(name);
        if (writes) return { kind: "global-var", name, writes };
        if (c.binding.globalvars.has(name)) return { kind: "global-var", name, writes: [] };
        const v = c.spec?.variables.get(name);
        if (v && !v.instance) return { kind: "builtin-variable", spec: v };
        return { kind: "undeclared", owner: "global", ownerName: "global", name };
      }
    }
    const ctx = this.contextOfExpression(obj);
    if (ctx.kind === "object") {
      const builtin = c.builtinInstanceVariable(name);
      if (builtin) return { kind: "builtin-variable", spec: builtin };
      const writes = c.objectVarWrites(ctx.object, name);
      if (writes) return { kind: "instance-var", object: ctx.object, name, writes };
      return { kind: "undeclared", owner: "object", ownerName: ctx.object, name };
    }
    if (ctx.kind === "struct" && ctx.ctor && c.binding.constructors.has(ctx.ctor)) {
      const writes = c.constructorFieldWrites(ctx.ctor, name);
      if (writes) return { kind: "struct-field", ctor: ctx.ctor, name, writes };
      return { kind: "undeclared", owner: "struct", ownerName: ctx.ctor, name };
    }
    if (ctx.kind === "global") {
      const writes = c.binding.globals.get(name);
      if (writes) return { kind: "global-var", name, writes };
    }
    return { kind: "unknown" };
  }

  /** The `self`-like context an expression designates (`obj_x`, `other`, an instance, a struct). */
  contextOfExpression(expr: AST.Expression): SelfContext {
    while (expr.type === "ParenthesizedExpression") expr = expr.expression;
    if (expr.type === "Identifier") {
      const r = this.resolve(expr);
      if (r?.kind === "asset" && r.resource.type === "object") return { kind: "object", object: r.resource.name };
      if (r?.kind === "keyword") {
        if (r.name === "self") return this.selfAt(expr);
        if (r.name === "other") return this.otherAt(expr);
        if (r.name === "global") return GLOBAL_SELF;
        return UNKNOWN_SELF;
      }
    }
    return this.checker.contextOfType(this.typeOf(expr));
  }

  // -------------------------------------------------------------------------
  // Types
  // -------------------------------------------------------------------------

  typeOf(node: AST.Expression | AST.AssignmentExpression): Type {
    const cached = this.types.get(node);
    if (cached) return cached;
    if (this.busy.has(node)) return T.unknown;
    this.busy.add(node);
    let t: Type;
    try {
      t = this.computeType(node);
    } finally {
      this.busy.delete(node);
    }
    this.types.set(node, t);
    return t;
  }

  typeOfFunctionNode(node: AST.FunctionLike): Type {
    const scope = this.binding.scopes.get(node);
    if (!scope) return T.function;
    return {
      kind: "function",
      signature: this.signatureOfScope(scope),
      constructorName: node.isConstructor ? scope.name : null,
    };
  }

  signatureOfScope(scope: FunctionScope): Signature {
    const cached = this.scopeSignatures.get(scope);
    if (cached) return cached;
    const sig = this.checker.scopeSignature(scope);
    // The return type is inferred on first access: most queries (argument
    // counts, parameter types) never need it, and inferring it walks the body.
    const checker = this.checker;
    let returnType: Type | null = null;
    const out: Signature = { ...sig };
    Object.defineProperty(out, "returnType", {
      enumerable: true,
      configurable: true,
      get: () => (returnType ??= checker.returnTypeOf(scope)),
      set: (t: Type) => {
        returnType = t;
      },
    });
    this.scopeSignatures.set(scope, out);
    return out;
  }

  /** Signature of whatever a call's callee refers to, if known. */
  signatureOfCallee(callee: AST.Expression): Signature | null {
    if (callee.type === "Identifier") {
      const r = this.resolve(callee);
      if (r) {
        const s = this.signatureOfResolution(r);
        if (s) return s;
      }
    }
    const t = this.typeOf(callee);
    if (t.kind === "function" && t.signature) return t.signature;
    return null;
  }

  signatureOfResolution(r: Resolution): Signature | null {
    switch (r.kind) {
      case "builtin-function":
        return this.checker.builtinSignature(r.spec);
      case "global-function":
        return this.checker.forFile(r.info.file).signatureOfScope(r.info.scope);
      case "extension-function":
        return {
          parameters: [],
          returnType: T.unknown,
          minArgs: r.minArgs,
          maxArgs: r.maxArgs,
          pure: false,
          deprecated: false,
        };
      default:
        return null;
    }
  }

  private computeType(node: AST.Expression | AST.AssignmentExpression): Type {
    switch (node.type) {
      case "Literal":
        switch (node.kind) {
          case "string":
          case "verbatim":
            return T.string;
          case "boolean":
            return T.bool;
          case "undefined":
            return T.undefined;
          default:
            return T.real;
        }
      case "TemplateLiteral":
        return T.string;
      case "ArrayExpression":
        return T.arrayOf(node.elements.length ? union(node.elements.map((e) => this.typeOf(e))) : T.unknown);
      case "StructExpression":
        return T.struct;
      case "FunctionExpression":
        return this.typeOfFunctionNode(node);
      case "ParenthesizedExpression":
        return this.typeOf(node.expression);
      case "UnaryExpression":
        return node.operator === "!" || node.operator === "not" ? T.bool : T.real;
      case "UpdateExpression":
        return T.real;
      case "BinaryExpression":
        return this.binaryType(node);
      case "LogicalExpression":
        if (node.operator === "??") return union([stripUndefined(this.typeOf(node.left)), this.typeOf(node.right)]);
        return T.bool;
      case "ConditionalExpression":
        return union([this.typeOf(node.consequent), this.typeOf(node.alternate)]);
      case "NewExpression":
        return node.callee.type === "Identifier" ? { kind: "struct", name: node.callee.name } : T.struct;
      case "CallExpression":
        return this.callType(node);
      case "MemberExpression":
        return this.memberType(node);
      case "IndexExpression": {
        if (node.accessor === "" || node.accessor === "@") {
          const t = this.typeOf(node.object);
          if (t.kind === "array") return node.indices.length > 1 && t.element.kind === "array" ? t.element.element : t.element;
        }
        return T.unknown;
      }
      case "Identifier":
        return this.identifierType(node);
      case "AssignmentExpression":
        return this.typeOf(node.right);
      default:
        return T.unknown;
    }
  }

  private binaryType(node: AST.BinaryExpression): Type {
    switch (node.operator) {
      case "+": {
        const l = this.typeOf(node.left);
        const r = this.typeOf(node.right);
        if (l.kind === "string" && r.kind === "string") return T.string;
        const hasString = (t: Type) => t.kind === "string" || (t.kind === "union" && t.types.some((m) => m.kind === "string"));
        if (isUnknown(l) || isUnknown(r)) return hasString(l) || hasString(r) ? T.string : T.unknown;
        if (!hasString(l) && !hasString(r)) return T.real;
        // Per member pair: two strings concatenate, two non-strings add; a mixed
        // pair is a runtime error, typed String (`"a" + (String|Undefined)`).
        const out: Type[] = [];
        for (const a of unionMembers(l)) for (const b of unionMembers(r)) out.push(a.kind !== "string" && b.kind !== "string" ? T.real : T.string);
        return union(out);
      }
      case "==": case "=": case "!=": case "<>": case "<": case "<=": case ">": case ">=":
        return T.bool;
      default:
        return T.real;
    }
  }

  private callType(node: AST.CallExpression): Type {
    const callee = node.callee;
    if (callee.type === "Identifier") {
      const r = this.resolve(callee);
      if (r?.kind === "builtin-function") {
        const sig = this.checker.builtinSignature(r.spec);
        if (sig.returnType.kind === "argument-identity") return this.argumentIdentityType(sig, node);
        if (sig.returnType.kind === "array" && sig.returnType.element.kind === "argument-identity") {
          return T.arrayOf(this.argumentIdentityType(sig, node));
        }
        if (callee.name === "method" && node.arguments[1]) return this.typeOf(node.arguments[1]);
        if ((callee.name === "instance_create_layer" || callee.name === "instance_create_depth") && node.arguments[3]) {
          const o = node.arguments[3];
          if (o.type === "Identifier" && this.checker.isObject(o.name)) return T.instance(o.name);
          return T.instance(null);
        }
        if ((callee.name === "instance_find" || callee.name === "instance_nearest" || callee.name === "instance_furthest" || callee.name === "instance_place" || callee.name === "instance_position") && node.arguments.length) {
          const o = node.arguments[callee.name === "instance_find" ? 0 : node.arguments.length - 1];
          if (o?.type === "Identifier" && this.checker.isObject(o.name)) return T.instance(o.name);
        }
        return sig.returnType;
      }
    }
    const sig = this.signatureOfCallee(callee);
    return sig ? sig.returnType : T.unknown;
  }

  /**
   * `ArgumentIdentity` return: the union of the arguments passed to
   * `ArgumentIdentity` parameters (`choose(1, 2)`), the element type of an
   * array argument (`array_pop(arr)`), else unknown (`ds_list_find_value`
   * returns whatever was stored; it is not the type of its arguments).
   */
  private argumentIdentityType(sig: Signature, node: AST.CallExpression): Type {
    const last = sig.parameters.at(-1);
    const identity: Type[] = [];
    let arrayArg: Type | null = null;
    for (const [i, a] of node.arguments.entries()) {
      const p = sig.parameters[i] ?? (last?.rest ? last : undefined);
      if (!p || !a) continue;
      if (p.type.kind === "argument-identity") identity.push(this.typeOf(a));
      else if (p.type.kind === "array" && arrayArg === null) arrayArg = this.typeOf(a);
    }
    if (identity.length) return union(identity);
    return arrayArg?.kind === "array" ? arrayArg.element : T.unknown;
  }

  private memberType(node: AST.MemberExpression): Type {
    const m = this.resolveMember(node);
    switch (m.kind) {
      case "builtin-variable":
        return parseType(m.spec.type);
      case "instance-var":
        return this.checker.objectVarType(m.object, m.name);
      case "struct-field":
        return this.checker.structFieldType(m.ctor, m.name);
      case "global-var":
        return this.checker.globalVarType(m.name);
      case "enum-member":
        return { kind: "enum", name: m.enumName };
      default:
        return T.unknown;
    }
  }

  private identifierType(node: AST.Identifier): Type {
    const r = this.resolve(node);
    if (!r) return T.unknown;
    const c = this.checker;
    switch (r.kind) {
      case "local": {
        const sym = r.symbol;
        if (sym.kind === "parameter") {
          const sig = sym.scope.node.type !== "Program" ? c.scopeSignature(sym.scope) : null;
          const p = sig?.parameters.find((pp) => pp.name === sym.name);
          if (p && !isUnknown(p.type)) return p.type;
          const init = sym.values[0];
          return init ? union([this.typeOf(init), T.unknown]) : T.unknown;
        }
        const values = sym.values.filter((v): v is AST.Expression => v !== null);
        if (values.length === 0) return T.unknown;
        const fc = c.forFile(sym.scope.file);
        return union(values.map((v) => fc.typeOf(v)));
      }
      case "macro": {
        const decl = r.declarations[0]!.node;
        return decl.expression ? literalType(decl.expression) : T.unknown;
      }
      case "keyword":
        switch (r.name) {
          case "self":
            return c.selfType(this.selfAt(node));
          case "other":
            return c.selfType(this.otherAt(node));
          case "global":
            return { kind: "struct", name: "$global" };
          case "noone":
            return T.instance(null);
          case "all":
            return T.constant("All");
        }
        return T.unknown;
      case "builtin-variable":
      case "builtin-constant":
        return parseType(r.spec.type);
      case "builtin-function":
        return { kind: "function", signature: c.builtinSignature(r.spec), constructorName: null };
      case "global-function":
        return c.forFile(r.info.file).typeOfFunctionNode(r.info.node);
      case "script":
        return T.asset("GMScript");
      case "asset":
        return T.asset(ASSET_SUBTYPE[r.resource.type] ?? null);
      case "room-instance":
        return T.instance(r.instance.object);
      case "extension-function":
        return T.function;
      case "global-var":
        return c.globalVarType(r.name);
      case "instance-var":
        return c.objectVarType(r.object, r.name);
      case "struct-field":
        return c.structFieldType(r.ctor, r.name);
      case "self-member":
        if (r.self.kind === "object") {
          const b = c.builtinInstanceVariable(r.name);
          if (b) return parseType(b.type);
        }
        return T.unknown;
      default:
        return T.unknown;
    }
  }
}

function stripUndefined(t: Type): Type {
  if (t.kind === "union") return union(t.types.filter((x) => x.kind !== "undefined"));
  return t;
}

/** Types of literal-ish macro bodies (no context available). */
function literalType(e: AST.Expression): Type {
  switch (e.type) {
    case "Literal":
      return e.kind === "string" || e.kind === "verbatim" ? T.string : e.kind === "boolean" ? T.bool : e.kind === "undefined" ? T.undefined : T.real;
    case "UnaryExpression":
      return e.operator === "!" || e.operator === "not" ? T.bool : literalType(e.argument).kind === "real" ? T.real : T.unknown;
    case "ParenthesizedExpression":
      return literalType(e.expression);
    case "TemplateLiteral":
      return T.string;
    default:
      return T.unknown;
  }
}
