/**
 * The checker's type model, modelled on Feather's type language:
 *
 *   Real, String, Bool, Undefined, Pointer, Any, Function, Struct, Array,
 *   Array[T] / Array<T>, Struct.Name, Id.Instance, Id.DsList, Asset.GMObject,
 *   Constant.Colour, Enum.Name, Pointer.View, unions with `|` or `,`.
 *
 * `unknown` means "not inferred"; it is compatible with everything and
 * suppresses type diagnostics (the checker never guesses).
 */

export type Type =
  | { kind: "unknown" }
  | { kind: "any" }
  | { kind: "real" }
  | { kind: "int64" }
  | { kind: "string" }
  | { kind: "bool" }
  | { kind: "undefined" }
  | { kind: "pointer"; sub: string | null }
  | { kind: "array"; element: Type }
  | { kind: "struct"; name: string | null }
  | { kind: "function"; signature: Signature | null; constructorName: string | null }
  | { kind: "id"; sub: string }
  | { kind: "asset"; sub: string | null }
  | { kind: "constant"; class: string | null }
  | { kind: "enum"; name: string }
  | { kind: "instance"; object: string | null }
  | { kind: "union"; types: Type[] }
  /** Spec `ArgumentIdentity`: "same type as the argument(s)" */
  | { kind: "argument-identity" };

export interface Parameter {
  name: string;
  type: Type;
  optional: boolean;
  rest: boolean;
}

export interface Signature {
  parameters: Parameter[];
  returnType: Type;
  minArgs: number;
  maxArgs: number;
  pure: boolean;
  deprecated: boolean;
}

export const T = {
  unknown: { kind: "unknown" } as Type,
  any: { kind: "any" } as Type,
  real: { kind: "real" } as Type,
  int64: { kind: "int64" } as Type,
  string: { kind: "string" } as Type,
  bool: { kind: "bool" } as Type,
  undefined: { kind: "undefined" } as Type,
  pointer: { kind: "pointer", sub: null } as Type,
  struct: { kind: "struct", name: null } as Type,
  function: { kind: "function", signature: null, constructorName: null } as Type,
  arrayOf(element: Type): Type {
    return { kind: "array", element };
  },
  array: { kind: "array", element: { kind: "unknown" } } as Type,
  instance(object: string | null = null): Type {
    return { kind: "instance", object };
  },
  id(sub: string): Type {
    return { kind: "id", sub };
  },
  asset(sub: string | null): Type {
    return { kind: "asset", sub };
  },
  constant(cls: string | null): Type {
    return { kind: "constant", class: cls };
  },
} as const;

/** Map from GameMaker resource type to Feather asset subtype. */
export const ASSET_SUBTYPE: Readonly<Record<string, string>> = {
  object: "GMObject",
  script: "GMScript",
  room: "GMRoom",
  sprite: "GMSprite",
  sound: "GMSound",
  path: "GMPath",
  font: "GMFont",
  timeline: "GMTimeline",
  tileset: "GMTileSet",
  sequence: "GMSequence",
  animcurve: "GMAnimCurve",
  shader: "GMShader",
  particlesystem: "GMParticleSystem",
};

// ---------------------------------------------------------------------------
// Parsing Feather / GmlSpec / JSDoc type strings
// ---------------------------------------------------------------------------

const cache = new Map<string, Type>();

/** Parses a type string such as `Array[Real]`, `Real|String`, `Id.Instance,Asset.GMObject`. */
export function parseType(text: string): Type {
  const key = text.trim();
  const hit = cache.get(key);
  if (hit) return hit;
  const t = new TypeParser(key).parseUnion();
  cache.set(key, t);
  return t;
}

class TypeParser {
  private pos = 0;
  private readonly s: string;
  constructor(s: string) {
    this.s = s;
  }

  private ws(): void {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos]!)) this.pos++;
  }

  parseUnion(): Type {
    const types: Type[] = [];
    do {
      this.ws();
      if (this.pos >= this.s.length) break;
      types.push(this.parseOne());
      this.ws();
    } while (this.eatAny("|,"));
    return union(types);
  }

  private eatAny(chars: string): boolean {
    this.ws();
    const c = this.s[this.pos];
    if (c !== undefined && chars.includes(c)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private ident(): string {
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.s.slice(this.pos));
    if (!m) {
      this.pos++;
      return "";
    }
    this.pos += m[0].length;
    return m[0];
  }

  private parseOne(): Type {
    this.ws();
    const head = this.ident();
    const parts = [head];
    while (this.s[this.pos] === ".") {
      this.pos++;
      parts.push(this.ident());
    }
    let arg: Type | null = null;
    this.ws();
    const open = this.s[this.pos];
    if (open === "[" || open === "<") {
      this.pos++;
      arg = this.parseUnion();
      this.ws();
      if (this.s[this.pos] === "]" || this.s[this.pos] === ">") this.pos++;
    }
    return fromName(parts, arg);
  }
}

function fromName(parts: string[], arg: Type | null): Type {
  const [head = "", ...rest] = parts;
  const sub = rest.join(".") || null;
  switch (head.toLowerCase()) {
    case "real":
    case "number":
    case "int":
    case "integer":
    case "double":
    case "float":
      return T.real;
    case "int64":
      return T.int64;
    case "string":
      return T.string;
    case "bool":
    case "boolean":
      return T.bool;
    case "undefined":
    case "void":
      return T.undefined;
    case "any":
    case "mixed":
      return T.any;
    case "pointer":
    case "ptr":
      return { kind: "pointer", sub };
    case "array":
      return { kind: "array", element: arg ?? T.unknown };
    case "struct":
      return { kind: "struct", name: sub };
    case "function":
    case "method":
      return { kind: "function", signature: null, constructorName: sub };
    case "id":
      if (sub === "Instance" || sub === null) return { kind: "instance", object: null };
      return { kind: "id", sub };
    case "asset":
      return { kind: "asset", sub };
    case "constant":
      return { kind: "constant", class: sub };
    case "enum":
      return sub ? { kind: "enum", name: sub } : T.real;
    case "argumentidentity":
      return { kind: "argument-identity" };
    default:
      // Unknown names in JSDoc are usually constructor/struct names
      if (head && /^[A-Za-z_]/.test(head)) return { kind: "struct", name: parts.join(".") };
      return T.unknown;
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export function union(types: Type[]): Type {
  const flat: Type[] = [];
  for (const t of types) {
    if (t.kind === "union") flat.push(...t.types);
    else flat.push(t);
  }
  if (flat.some((t) => t.kind === "unknown")) return T.unknown;
  if (flat.some((t) => t.kind === "any")) return T.any;
  const unique: Type[] = [];
  for (const t of flat) if (!unique.some((u) => sameType(u, t))) unique.push(t);
  if (unique.length === 0) return T.unknown;
  if (unique.length === 1) return unique[0]!;
  return { kind: "union", types: unique };
}

export function sameType(a: Type, b: Type): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "pointer": return a.sub === (b as typeof a).sub;
    case "array": return sameType(a.element, (b as typeof a).element);
    case "struct": return a.name === (b as typeof a).name;
    case "function": return a.constructorName === (b as typeof a).constructorName && a.signature === (b as typeof a).signature;
    case "id": return a.sub === (b as typeof a).sub;
    case "asset": return a.sub === (b as typeof a).sub;
    case "constant": return a.class === (b as typeof a).class;
    case "enum": return a.name === (b as typeof a).name;
    case "instance": return a.object === (b as typeof a).object;
    case "union": {
      const bu = b as typeof a;
      return a.types.length === bu.types.length && a.types.every((t) => bu.types.some((u) => sameType(t, u)));
    }
    default: return true;
  }
}

export function isUnknown(t: Type): boolean {
  return t.kind === "unknown" || t.kind === "any" || t.kind === "argument-identity";
}

/** Types that GameMaker represents as numbers at runtime (handles, constants, assets, enums). */
export function isNumberLike(t: Type): boolean {
  switch (t.kind) {
    case "real":
    case "int64":
    case "bool":
    case "constant":
    case "enum":
      return true;
    default:
      return false;
  }
}

/**
 * Whether a value of type `source` may be passed where `target` is expected.
 * Lenient: unknown/any on either side is assignable, and GameMaker's
 * numeric handles accept reals (legacy code passes numbers).
 */
export function isAssignable(source: Type, target: Type): boolean {
  if (isUnknown(source) || isUnknown(target)) return true;
  if (target.kind === "union") return target.types.some((t) => isAssignable(source, t));
  // Flow-insensitive unions (e.g. `var a = undefined; a = 5;`) are accepted
  // when any member fits; the checker prefers silence over false positives.
  if (source.kind === "union") return source.types.some((s) => isAssignable(s, target));
  switch (target.kind) {
    case "real":
    case "int64":
      return isNumberLike(source);
    case "bool":
      return source.kind === "bool" || source.kind === "real" || source.kind === "int64";
    case "string":
      return source.kind === "string";
    case "undefined":
      return source.kind === "undefined";
    case "pointer":
      return source.kind === "pointer" || source.kind === "undefined";
    case "array":
      return source.kind === "array" && (isUnknown(source.element) || isUnknown(target.element) || isAssignable(source.element, target.element));
    case "struct":
      if (source.kind === "struct") return target.name === null || source.name === null || source.name === target.name;
      return source.kind === "instance"; // instances can stand in for structs in many APIs
    case "function":
      return source.kind === "function";
    case "id":
      return (source.kind === "id" && source.sub === target.sub) || source.kind === "real" || source.kind === "int64";
    case "instance":
      return source.kind === "instance" || (source.kind === "asset" && (source.sub === "GMObject" || source.sub === null)) || source.kind === "real" || source.kind === "constant";
    case "asset":
      if (source.kind === "asset") return target.sub === null || source.sub === null || source.sub === target.sub;
      return source.kind === "real" || source.kind === "int64";
    case "constant":
      return source.kind === "constant" || source.kind === "real" || source.kind === "int64" || source.kind === "bool";
    case "enum":
      return source.kind === "enum" || source.kind === "real" || source.kind === "int64";
    default:
      return true;
  }
}

export function typeToString(t: Type): string {
  switch (t.kind) {
    case "unknown": return "Unknown";
    case "any": return "Any";
    case "real": return "Real";
    case "int64": return "Int64";
    case "string": return "String";
    case "bool": return "Bool";
    case "undefined": return "Undefined";
    case "pointer": return t.sub ? `Pointer.${t.sub}` : "Pointer";
    case "array": return isUnknown(t.element) ? "Array" : `Array<${typeToString(t.element)}>`;
    case "struct": return t.name ? `Struct.${t.name}` : "Struct";
    case "function": return t.constructorName ? `Function.${t.constructorName}` : "Function";
    case "id": return `Id.${t.sub}`;
    case "asset": return t.sub ? `Asset.${t.sub}` : "Asset";
    case "constant": return t.class ? `Constant.${t.class}` : "Constant";
    case "enum": return `Enum.${t.name}`;
    case "instance": return t.object ? `Id.Instance<${t.object}>` : "Id.Instance";
    case "union": return t.types.map(typeToString).join(" | ");
    case "argument-identity": return "Any";
  }
}

/**
 * Whether a type is fully inferred: not unknown/any/argument-identity, and for
 * unions every member is definite. Type diagnostics only fire on definite types.
 */
export function isDefinite(t: Type): boolean {
  if (t.kind === "union") return t.types.every(isDefinite);
  return !isUnknown(t);
}

/** Members of a union, or the type itself. */
export function unionMembers(t: Type): Type[] {
  return t.kind === "union" ? t.types : [t];
}

/**
 * Broad runtime representation of a type, for "differing types" rules
 * (GM1035, GM1043, GM1063). `null` for handle-like types (ids, assets,
 * instances) whose representation varies across runtime versions; they
 * never conflict with anything.
 */
export type TypeCategory = "number" | "string" | "array" | "struct" | "function" | "pointer" | "undefined";

export function typeCategory(t: Type): TypeCategory | null {
  switch (t.kind) {
    case "real":
    case "int64":
    case "bool":
    case "constant":
    case "enum":
      return "number";
    case "string":
      return "string";
    case "array":
      return "array";
    case "struct":
      return "struct";
    case "function":
      return "function";
    case "pointer":
      return "pointer";
    case "undefined":
      return "undefined";
    default:
      return null;
  }
}

/** Constant classes are spelled both ways (`Constant.Colour` in docs, `Color` in the spec). */
export function normaliseConstantClass(cls: string): string {
  return cls.toLowerCase().replace(/colour/g, "color");
}

/** Feather `Asset.*` subtypes. */
export const ASSET_SUBTYPES: readonly string[] = [...new Set([...Object.values(ASSET_SUBTYPE), "GMAudioGroup", "GMTileSet", "GMNotes", "GMExtension", "Script"])];

const PLAIN_TYPE_NAMES = new Set([
  "real", "number", "int", "integer", "double", "float", "int64", "string", "bool", "boolean",
  "undefined", "void", "any", "mixed", "array", "function", "method", "argumentidentity",
]);
/** Names that take a `.Sub` qualifier (and may stand alone). */
const QUALIFIED_TYPE_NAMES = new Set(["struct", "id", "asset", "constant", "enum", "pointer", "ptr", "function", "method"]);

export interface TypeValidationOptions {
  /** Project names usable as bare types (constructors, enums). */
  isKnownName?: (name: string) => boolean;
  /** Known `Constant.*` classes; null accepts any. */
  constantClasses?: ReadonlySet<string> | null;
}

/**
 * Validates a JSDoc/Feather type string (`Array<Real>`, `Id.Instance|Undefined`).
 * Returns null when well formed, else a short reason. Used for GM1062.
 */
export function validateTypeText(s: string, options: TypeValidationOptions = {}): string | null {
  let pos = 0;
  const ws = () => {
    while (pos < s.length && /\s/.test(s[pos]!)) pos++;
  };
  const ident = (): string | null => {
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(s.slice(pos));
    if (!m) return null;
    pos += m[0].length;
    return m[0];
  };
  const one = (): string | null => {
    ws();
    const head = ident();
    if (head === null) return pos >= s.length ? "missing type name" : `unexpected '${s[pos]}'`;
    const parts = [head];
    while (s[pos] === ".") {
      pos++;
      const p = ident();
      if (p === null) return "missing name after '.'";
      parts.push(p);
    }
    const err = checkName(parts, options);
    if (err) return err;
    ws();
    const open = s[pos];
    if (open === "<" || open === "[") {
      pos++;
      const inner = union();
      if (inner) return inner;
      ws();
      const close = s[pos];
      if (close !== (open === "<" ? ">" : "]")) return `unclosed '${open}'`;
      pos++;
    }
    return null;
  };
  const union = (): string | null => {
    for (;;) {
      const e = one();
      if (e) return e;
      ws();
      if (s[pos] === "|" || s[pos] === ",") {
        pos++;
        continue;
      }
      return null;
    }
  };
  if (s.trim() === "") return "empty type";
  const e = union();
  if (e) return e;
  ws();
  if (pos < s.length) return `unexpected '${s[pos]}'`;
  return null;
}

function checkName(parts: string[], options: TypeValidationOptions): string | null {
  const head = parts[0]!.toLowerCase();
  const sub = parts.slice(1).join(".");
  if (parts.length === 1) {
    if (PLAIN_TYPE_NAMES.has(head) || QUALIFIED_TYPE_NAMES.has(head)) return null;
  } else if (QUALIFIED_TYPE_NAMES.has(head)) {
    if (head === "asset" && !ASSET_SUBTYPES.some((a) => a.toLowerCase() === sub.toLowerCase())) return `unknown asset type '${sub}'`;
    if (head === "constant" && options.constantClasses && !options.constantClasses.has(normaliseConstantClass(sub))) return `unknown constant group '${sub}'`;
    return null;
  }
  if (options.isKnownName?.(parts.join("."))) return null;
  return `unknown type '${parts.join(".")}'`;
}
