/**
 * Binder: one syntactic pass per file that
 *  - records parent links and function scopes (with their `self` context),
 *  - declares locals, parameters and statics,
 *  - collects project-wide declarations: global functions, constructors,
 *    enums, macros, globalvars, global variables, instance variables written
 *    to objects (directly, via `with`, via `obj.var`, via instance_create
 *    structs, via Variable Definitions) and constructor fields.
 *
 * It does no type inference; the Checker resolves names and types lazily on
 * top of these tables.
 */

import type * as AST from "@gml-lint/parser";
import { childNodes } from "@gml-lint/parser";
import type { EventInfo, Project } from "@gml-lint/project";
import { docFor, type DocComment } from "./jsdoc.js";
import type { SourceFile } from "./program.js";

export type SelfContext =
  | { kind: "object"; object: string }
  | { kind: "struct"; ctor: string | null; node: AST.Node | null }
  | { kind: "global" }
  | { kind: "unknown" };

export const UNKNOWN_SELF: SelfContext = { kind: "unknown" };
export const GLOBAL_SELF: SelfContext = { kind: "global" };

export interface LocalSymbol {
  kind: "local" | "parameter" | "static";
  name: string;
  /** Declaring identifiers, in source order. */
  declarations: AST.Identifier[];
  scope: FunctionScope;
  /** Innermost block containing the first `var` (for GM2043). */
  block: AST.Node;
  /** Initialisers/assignments, for type inference. */
  values: Array<AST.Expression | null>;
}

export interface FunctionScope {
  node: AST.Program | AST.FunctionLike;
  file: SourceFile;
  parent: FunctionScope | null;
  locals: Map<string, LocalSymbol>;
  self: SelfContext;
  /** `other` at the start of this scope. */
  other: SelfContext;
  isConstructor: boolean;
  /** Name, for declared functions or `name = function...` assignments. */
  name: string | null;
  doc: DocComment | null;
  usesArgumentArray: boolean;
  usesArgumentCount: boolean;
  argumentN: Map<number, AST.Identifier[]>;
  returns: AST.ReturnStatement[];
}

/** A write to a variable outside the current function's locals. */
export interface Write {
  file: SourceFile;
  /** The assignment-like node (AssignmentExpression, VariableDeclarator, StructProperty, CallExpression...). */
  node: AST.Node;
  /** The identifier (or string literal) naming the variable at the write. */
  nameNode: AST.Node;
  value: AST.Expression | null;
  /** Scope in which `value` is evaluated. */
  scope: FunctionScope;
  /** Event the write occurs in (when in an object event), else null. */
  event: EventInfo | null;
  /** In the owner object's own Create event (or Variable Definitions / creation code). */
  inCreate: boolean;
  /** The write happens in the target's own context (not via `with`/`obj.var`). */
  direct: boolean;
}

export interface GlobalFunctionInfo {
  name: string;
  node: AST.FunctionDeclaration;
  file: SourceFile;
  scope: FunctionScope;
  doc: DocComment | null;
}

export interface ConstructorInfo {
  name: string;
  node: AST.FunctionLike;
  file: SourceFile;
  scope: FunctionScope;
  parent: string | null;
  fields: Map<string, Write[]>;
  statics: Map<string, Write[]>;
}

export interface Declaration<T extends AST.Node> {
  node: T;
  file: SourceFile;
}

export interface FileBinding {
  file: SourceFile;
  parents: WeakMap<AST.Node, AST.Node>;
  scopes: Map<AST.Node, FunctionScope>;
  root: FunctionScope;
}

export class Binding {
  readonly files = new Map<string, FileBinding>();
  readonly globalFunctions = new Map<string, GlobalFunctionInfo[]>();
  readonly constructors = new Map<string, ConstructorInfo>();
  readonly enums = new Map<string, Array<Declaration<AST.EnumDeclaration>>>();
  readonly macros = new Map<string, Array<Declaration<AST.MacroDeclaration>>>();
  readonly globalvars = new Map<string, Array<Declaration<AST.Identifier>>>();
  /** `global.x = ...` and script top-level implicit globals. */
  readonly globals = new Map<string, Write[]>();
  /** Instance variables written to each object (not including ancestors). */
  readonly objectVars = new Map<string, Map<string, Write[]>>();
  /** Objects with writes whose variable name is computed at runtime. */
  readonly dynamicObjects = new Set<string>();
  /** Variable names written through targets the binder could not identify. */
  readonly unknownTargetWrites = new Set<string>();
  /** Any computed-name write to an unknown target. */
  dynamicUnknown = false;
}

const INSTANCE_CREATE_FUNCTIONS: Readonly<Record<string, number>> = {
  instance_create_layer: 3,
  instance_create_depth: 3,
};

export function bind(files: Iterable<SourceFile>, project: Project | null): Binding {
  const binding = new Binding();
  const list = [...files];
  // Functions named as a parent (`function B() : A() constructor`) act as
  // constructors even when `A` lacks the keyword (GM1054 reports that).
  const parentNames = new Set<string>();
  for (const f of list) collectParentNames(f.ast, parentNames);
  const binder = new FileBinder(binding, project, parentNames);
  for (const f of list) binding.files.set(f.path, binder.bindFile(f));
  if (project) addVariableDefinitions(binding, project);
  return binding;
}

function addVariableDefinitions(binding: Binding, project: Project): void {
  for (const obj of project.objects.values()) {
    for (const prop of obj.properties) {
      const map = getOrCreate(binding.objectVars, obj.name, () => new Map<string, Write[]>());
      // Variable Definitions have no GML node: declared, with no writes.
      if (!map.has(prop.name)) map.set(prop.name, []);
    }
  }
}

function collectParentNames(node: AST.Node, out: Set<string>): void {
  if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression") && node.parent) out.add(node.parent.callee.name);
  for (const child of childNodes(node)) collectParentNames(child, out);
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let v = map.get(key);
  if (v === undefined) {
    v = make();
    map.set(key, v);
  }
  return v;
}

interface Ctx {
  scope: FunctionScope;
  self: SelfContext;
  other: SelfContext;
  /** Innermost block-like node (for var block scoping). */
  block: AST.Node;
  event: EventInfo | null;
  /** In the Create event of `self`'s object (or creation code). */
  inCreate: boolean;
  /** Writes in this context target self directly (false inside `with`). */
  direct: boolean;
}

class FileBinder {
  private readonly binding: Binding;
  private readonly project: Project | null;
  private readonly parentNames: ReadonlySet<string>;
  private file!: SourceFile;
  private fb!: FileBinding;

  constructor(binding: Binding, project: Project | null, parentNames: ReadonlySet<string>) {
    this.binding = binding;
    this.project = project;
    this.parentNames = parentNames;
  }

  bindFile(file: SourceFile): FileBinding {
    this.file = file;
    const gml = file.gml;
    let self: SelfContext = UNKNOWN_SELF;
    let other: SelfContext = UNKNOWN_SELF;
    let inCreate = false;
    let event: EventInfo | null = null;
    if (gml?.kind === "event") {
      self = { kind: "object", object: gml.owner };
      event = gml.event ?? null;
      inCreate = event?.type === "Create" || event?.type === "PreCreate";
      if (event?.type === "Collision" && event.collisionObject) other = { kind: "object", object: event.collisionObject };
    } else if (gml?.kind === "instance-creation") {
      self = gml.instance?.object ? { kind: "object", object: gml.instance.object } : UNKNOWN_SELF;
      inCreate = true;
    } else if (gml?.kind === "script") {
      self = GLOBAL_SELF;
    }
    const root = this.newScope(file.ast, null, self, other, null, null, false);
    this.fb = { file, parents: new WeakMap(), scopes: new Map([[file.ast, root]]), root };
    const ctx: Ctx = { scope: root, self, other, block: file.ast, event, inCreate, direct: true };
    for (const s of file.ast.body) this.visit(s, file.ast, ctx);
    return this.fb;
  }

  private newScope(
    node: AST.Program | AST.FunctionLike,
    parent: FunctionScope | null,
    self: SelfContext,
    other: SelfContext,
    name: string | null,
    doc: DocComment | null,
    isConstructor: boolean,
  ): FunctionScope {
    return {
      node,
      file: this.file,
      parent,
      locals: new Map(),
      self,
      other,
      isConstructor,
      name,
      doc,
      usesArgumentArray: false,
      usesArgumentCount: false,
      argumentN: new Map(),
      returns: [],
    };
  }

  private isObject(name: string): boolean {
    return !!this.project?.objects.has(name);
  }

  private visit(node: AST.Node, parent: AST.Node, ctx: Ctx): void {
    this.fb.parents.set(node, parent);
    switch (node.type) {
      case "FunctionDeclaration":
        return this.visitFunction(node, parent, ctx, node.id.name);
      case "FunctionExpression":
        return this.visitFunction(node, parent, ctx, this.functionNameFromParent(node, parent));
      case "VariableDeclaration":
        return this.visitVariableDeclaration(node, ctx);
      case "AssignmentExpression":
        this.visitAssignment(node, ctx);
        break;
      case "WithStatement":
        return this.visitWith(node, ctx);
      case "BlockStatement":
        this.visitChildren(node, { ...ctx, block: node });
        return;
      case "ReturnStatement":
        ctx.scope.returns.push(node);
        break;
      case "EnumDeclaration":
        getOrCreate(this.binding.enums, node.id.name, () => []).push({ node, file: this.file });
        break;
      case "MacroDeclaration":
        getOrCreate(this.binding.macros, node.id.name, () => []).push({ node, file: this.file });
        break;
      case "Identifier":
        this.noteArgumentUse(node, ctx);
        return;
      case "CallExpression":
        this.visitCall(node, ctx);
        break;
      case "IndexExpression":
        this.noteArgumentArray(node, ctx);
        break;
      case "StructExpression":
        return this.visitStruct(node, ctx);
      case "CatchClause":
        if (node.param) {
          const sym = getOrCreate(ctx.scope.locals, node.param.name, () => ({
            kind: "local" as const,
            name: node.param!.name,
            declarations: [],
            scope: ctx.scope,
            block: node.body,
            values: [],
          }));
          sym.declarations.push(node.param);
          sym.values.push(null);
        }
        break;
    }
    this.visitChildren(node, ctx);
  }

  private visitChildren(node: AST.Node, ctx: Ctx): void {
    for (const child of childNodes(node)) this.visit(child, node, ctx);
  }

  private noteArgumentUse(id: AST.Identifier, ctx: Ctx): void {
    const name = id.name;
    if (name === "argument_count") ctx.scope.usesArgumentCount = true;
    else if (name.startsWith("argument")) {
      const m = /^argument(\d{1,2})$/.exec(name);
      if (m) getOrCreate(ctx.scope.argumentN, Number(m[1]), () => []).push(id);
    }
  }

  private noteArgumentArray(node: AST.IndexExpression, ctx: Ctx): void {
    if (node.object.type === "Identifier" && node.object.name === "argument") ctx.scope.usesArgumentArray = true;
  }

  private functionNameFromParent(node: AST.FunctionExpression, parent: AST.Node): string | null {
    if (parent.type === "AssignmentExpression") {
      const l = parent.left;
      if (l.type === "Identifier") return l.name;
      if (l.type === "MemberExpression") return l.property.name;
    }
    if (parent.type === "VariableDeclarator") return parent.id.name;
    if (parent.type === "StructProperty") return parent.key.type === "Identifier" ? parent.key.name : String(parent.key.value);
    return node.id?.name ?? null;
  }

  private visitFunction(node: AST.FunctionLike, parent: AST.Node, ctx: Ctx, name: string | null): void {
    const isTopLevelScriptFunction =
      node.type === "FunctionDeclaration" && ctx.scope.node.type === "Program" && this.file.gml?.kind === "script";
    const doc = docFor(this.file.docs, this.file.text, docAnchor(node, parent));
    const isConstructor = node.isConstructor || (isTopLevelScriptFunction && name !== null && this.parentNames.has(name));

    let self: SelfContext;
    if (isConstructor) {
      self = { kind: "struct", ctor: name, node };
    } else if (doc?.self) {
      const t = doc.self.type;
      self = t.kind === "instance" && t.object ? { kind: "object", object: t.object } : t.kind === "struct" ? { kind: "struct", ctor: t.name, node: null } : UNKNOWN_SELF;
    } else if (isTopLevelScriptFunction) {
      self = UNKNOWN_SELF; // called from anywhere
    } else if (parent.type === "StructProperty") {
      self = { kind: "struct", ctor: null, node: this.fb.parents.get(parent) ?? null };
    } else if (this.isRebound(node, parent)) {
      self = UNKNOWN_SELF;
    } else {
      self = ctx.self.kind === "global" ? UNKNOWN_SELF : ctx.self; // methods bind to the creating instance/struct
    }

    const scope = this.newScope(node, ctx.scope, self, UNKNOWN_SELF, name, doc, isConstructor);
    this.fb.scopes.set(node, scope);

    if (isTopLevelScriptFunction && node.type === "FunctionDeclaration") {
      getOrCreate(this.binding.globalFunctions, node.id.name, () => []).push({
        name: node.id.name,
        node,
        file: this.file,
        scope,
        doc,
      });
    } else if (node.type === "FunctionDeclaration") {
      // A named function inside an event/function becomes a method variable on self.
      this.recordSelfWrite(node.id, node, null, ctx);
    }

    if (isConstructor && name && (!this.binding.constructors.has(name) || isTopLevelScriptFunction)) {
      this.binding.constructors.set(name, {
        name,
        node,
        file: this.file,
        scope,
        parent: node.parent?.callee.name ?? null,
        fields: new Map(),
        statics: new Map(),
      });
    }

    for (const p of node.params) {
      this.fb.parents.set(p, node);
      this.fb.parents.set(p.id, p);
      const sym = getOrCreate(scope.locals, p.id.name, () => ({
        kind: "parameter" as const,
        name: p.id.name,
        declarations: [],
        scope,
        block: node.body,
        values: [],
      }));
      sym.declarations.push(p.id);
      sym.values.push(p.init);
      if (p.init) this.visit(p.init, p, { ...ctx, scope, self, other: UNKNOWN_SELF, block: node.body, direct: true });
    }
    if (node.id) this.fb.parents.set(node.id, node);
    if (node.parent) this.visit(node.parent, node, { ...ctx, scope, self, block: node.body });

    const inner: Ctx = {
      scope,
      self,
      other: UNKNOWN_SELF,
      block: node.body,
      event: ctx.event,
      inCreate: isConstructor,
      direct: true,
    };
    this.fb.parents.set(node.body, node);
    this.visitChildren(node.body, inner);
  }

  /**
   * Functions passed as arguments may be rebound by the receiver
   * (`method(target, fn)`, UI libraries storing callbacks with `method(self, fn)`),
   * so their `self` is unknown.
   */
  private isRebound(node: AST.FunctionExpression | AST.FunctionDeclaration, parent: AST.Node): boolean {
    // Look through `cond ? function(){} : undefined`, `(function(){})`, `a ?? function(){}`
    let child: AST.Node = node;
    let p: AST.Node | undefined = parent;
    while (p && (p.type === "ConditionalExpression" || p.type === "ParenthesizedExpression" || p.type === "LogicalExpression")) {
      child = p;
      p = this.fb.parents.get(p);
    }
    if (!p || (p.type !== "CallExpression" && p.type !== "NewExpression")) return false;
    return p.arguments.includes(child as AST.Expression);
  }

  private visitVariableDeclaration(node: AST.VariableDeclaration, ctx: Ctx): void {
    for (const d of node.declarations) {
      this.fb.parents.set(d, node);
      this.fb.parents.set(d.id, d);
      if (node.kind === "globalvar") {
        getOrCreate(this.binding.globalvars, d.id.name, () => []).push({ node: d.id, file: this.file });
      } else {
        const kind: LocalSymbol["kind"] = node.kind === "static" ? "static" : "local";
        const sym = getOrCreate(ctx.scope.locals, d.id.name, () => ({
          kind,
          name: d.id.name,
          declarations: [],
          scope: ctx.scope,
          block: ctx.block,
          values: [],
        }));
        sym.declarations.push(d.id);
        sym.values.push(d.init);
        if (node.kind === "static" && ctx.scope.isConstructor && ctx.scope.name) {
          const info = this.binding.constructors.get(ctx.scope.name);
          if (info) getOrCreate(info.statics, d.id.name, () => []).push(this.makeWrite(d, d.id, d.init, ctx));
        }
      }
      if (d.init) this.visit(d.init, d, ctx);
    }
  }

  private makeWrite(node: AST.Node, nameNode: AST.Node, value: AST.Expression | null, ctx: Ctx): Write {
    return { file: this.file, node, nameNode, value, scope: ctx.scope, event: ctx.event, inCreate: ctx.inCreate, direct: ctx.direct };
  }

  private visitAssignment(node: AST.AssignmentExpression, ctx: Ctx): void {
    if (node.operator !== "=" && node.operator !== ":=" && node.operator !== "??=") return;
    const left = node.left;
    if (left.type === "Identifier") {
      if (ctx.scope.locals.has(left.name)) {
        const sym = ctx.scope.locals.get(left.name)!;
        if (sym.declarations[0]!.range[0] < left.range[0]) {
          sym.values.push(node.right);
          return;
        }
      }
      this.recordSelfWrite(left, node, node.right, ctx);
    } else if (left.type === "MemberExpression") {
      this.recordMemberWrite(left.object, left.property, node, node.right, ctx);
    } else if (left.type === "IndexExpression" && (left.accessor === "" || left.accessor === "@")) {
      // `arr[i] = v` creates `arr` when it does not exist yet
      let base: AST.Expression = left;
      while (base.type === "IndexExpression" && (base.accessor === "" || base.accessor === "@")) base = base.object;
      if (base.type === "Identifier" && !ctx.scope.locals.has(base.name)) this.recordSelfWrite(base, node, null, ctx);
      else if (base.type === "MemberExpression") this.recordMemberWrite(base.object, base.property, node, null, ctx);
    } else if (left.type === "IndexExpression" && left.accessor === "$" && left.indices.length === 1) {
      const key = left.indices[0]!;
      const targetSelf = this.contextOfTarget(left.object, ctx);
      if (key.type === "Literal" && typeof key.value === "string") {
        this.recordWriteTo(targetSelf, key.value, key, node, node.right, ctx, false);
      } else {
        this.markDynamic(targetSelf);
      }
    }
  }

  private markDynamic(target: SelfContext | null): void {
    if (target?.kind === "object") this.binding.dynamicObjects.add(target.object);
    else if (target === null || target.kind === "unknown") this.binding.dynamicUnknown = true;
  }

  /** Bare `name = value` in the current context. */
  private recordSelfWrite(nameNode: AST.Identifier, node: AST.Node, value: AST.Expression | null, ctx: Ctx): void {
    this.recordWriteTo(ctx.self, nameNode.name, nameNode, node, value, ctx, ctx.direct);
  }

  private recordWriteTo(
    target: SelfContext | null,
    name: string,
    nameNode: AST.Node,
    node: AST.Node,
    value: AST.Expression | null,
    ctx: Ctx,
    direct: boolean,
  ): void {
    const write = { ...this.makeWrite(node, nameNode, value, ctx), direct };
    if (target === null || target.kind === "unknown") {
      this.binding.unknownTargetWrites.add(name);
      return;
    }
    if (target.kind === "global") {
      getOrCreate(this.binding.globals, name, () => []).push(write);
      return;
    }
    if (target.kind === "object") {
      const map = getOrCreate(this.binding.objectVars, target.object, () => new Map<string, Write[]>());
      getOrCreate(map, name, () => []).push(write);
      return;
    }
    // struct
    if (target.ctor) {
      const info = this.binding.constructors.get(target.ctor);
      if (info) getOrCreate(info.fields, name, () => []).push(write);
    }
  }

  /** Context designated by an expression used as a write/with target (syntactic). */
  private contextOfTarget(expr: AST.Expression, ctx: Ctx): SelfContext | null {
    while (expr.type === "ParenthesizedExpression") expr = expr.expression;
    if (expr.type === "Identifier") {
      switch (expr.name) {
        case "self":
        case "id":
          return ctx.scope.locals.has(expr.name) ? null : ctx.self;
        case "other":
          return ctx.other;
        case "global":
          return GLOBAL_SELF;
        case "all":
          return null;
      }
      if (this.isObject(expr.name) && !ctx.scope.locals.has(expr.name)) return { kind: "object", object: expr.name };
    }
    return null;
  }

  private recordMemberWrite(
    object: AST.Expression,
    property: AST.Identifier,
    node: AST.Node,
    value: AST.Expression | null,
    ctx: Ctx,
  ): void {
    const target = this.contextOfTarget(object, ctx);
    const direct = object.type === "Identifier" && object.name === "self" && ctx.direct;
    this.recordWriteTo(target, property.name, property, node, value, ctx, direct);
  }

  private visitWith(node: AST.WithStatement, ctx: Ctx): void {
    this.visit(node.object, node, ctx);
    const self = this.contextOfTarget(node.object, ctx) ?? UNKNOWN_SELF;
    this.visit(node.body, node, { ...ctx, self, other: ctx.self, direct: false, inCreate: false });
  }

  private visitStruct(node: AST.StructExpression, ctx: Ctx): void {
    for (const p of node.properties) {
      this.fb.parents.set(p, node);
      this.fb.parents.set(p.key, p);
      if (p.value) this.visit(p.value, p, ctx);
    }
  }

  private visitCall(node: AST.CallExpression, ctx: Ctx): void {
    const callee = node.callee;
    if (callee.type !== "Identifier") return;
    const objIndex = INSTANCE_CREATE_FUNCTIONS[callee.name];
    if (objIndex !== undefined) {
      const objArg = node.arguments[objIndex];
      const structArg = node.arguments[objIndex + 1];
      if (structArg && structArg.type === "StructExpression") {
        const target = objArg ? this.contextOfTarget(objArg, ctx) : null;
        for (const p of structArg.properties) {
          const name = p.key.type === "Identifier" ? p.key.name : String(p.key.value);
          this.recordWriteTo(target, name, p.key, p, p.value, ctx, false);
        }
      }
      return;
    }
    if (callee.name === "variable_instance_set" || callee.name === "variable_struct_set" || callee.name === "struct_set") {
      const targetArg = node.arguments[0];
      const nameArg = node.arguments[1];
      const target = targetArg ? this.contextOfTarget(targetArg, ctx) : null;
      if (nameArg && nameArg.type === "Literal" && typeof nameArg.value === "string") {
        this.recordWriteTo(target, nameArg.value, nameArg, node, node.arguments[2] ?? null, ctx, false);
      } else {
        this.markDynamic(target);
      }
    } else if (callee.name === "variable_global_set") {
      const nameArg = node.arguments[0];
      if (nameArg && nameArg.type === "Literal" && typeof nameArg.value === "string") {
        this.recordWriteTo(GLOBAL_SELF, nameArg.value, nameArg, node, node.arguments[1] ?? null, ctx, false);
      }
    }
  }
}

/** Where a function's doc comment would be: before the statement containing it. */
function docAnchor(node: AST.FunctionLike, parent: AST.Node): number {
  if (node.type === "FunctionDeclaration") return node.range[0];
  // `foo = function() {}` / `var foo = function() {}` / `static foo = function() {}`
  if (parent.type === "AssignmentExpression" || parent.type === "VariableDeclarator" || parent.type === "StructProperty") {
    return parent.range[0];
  }
  return node.range[0];
}
