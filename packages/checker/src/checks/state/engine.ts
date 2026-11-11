/**
 * Draw/GPU state engine shared by the state checks (GM2000, GM2003, ...).
 *
 * One analysis per file, cached on the file's AST and shared by every state
 * check. Each *code body* (an event/script file's top level, or one function
 * body; nested functions are separate bodies and never leak state) is
 * interpreted abstractly over the AST:
 *
 *  - sequence, if/else (both branches), switch (each case incl. fallthrough;
 *    no `default` adds a skip path), loops / `with` (body runs 0..n times:
 *    iterated until the states at the loop head repeat, bounded),
 *    try/catch/finally (approximate), `a && b` / `a ?? b` / `c ? a : b`
 *  - `return`/`exit` end the body ("not restored" is checked there), `throw`
 *    drops the path, `break`/`continue` jump to the loop/switch exit
 *
 * The analysis is path sensitive (a set of concrete states per program point)
 * but split into independent *runs*, one per tracked family (draw alpha, draw
 * colour, blend mode + gpu stack, shader, surface stack, vertex batch, ...),
 * so states never form a cross product between families. Two refinements
 * over Feather avoid false positives:
 *  - condition facts: when an `if` makes paths diverge, each path remembers
 *    the (call-free) condition's value, so `if (c) set(); ...; if (c) reset();`
 *    (also `||`/`&&`/`!` combinations) is understood; facts are forgotten when
 *    a variable they read is assigned, and do not cross `with` boundaries
 *  - `var _old = draw_get_alpha(); ...; draw_set_alpha(_old)` counts as a reset
 * Vertex batches are tracked per buffer (first argument text). Statements that
 * neither call a function of the run's family nor jump are skipped in O(1)
 * thanks to a per-node bitmask computed in a single pre-pass.
 */

import type * as AST from "@gml-lint/parser";
import { childNodes } from "@gml-lint/parser";
import type { CheckContext } from "../api.js";
import { unparen } from "../util.js";

export interface StateFinding {
  code: string;
  range: AST.Range;
  message: string;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

type Args = ReadonlyArray<AST.Expression | null>;

function isName(a: AST.Expression | null | undefined, name: string): boolean {
  if (!a) return false;
  const e = unparen(a);
  return e.type === "Identifier" && e.name === name;
}

/** Numeric value of a literal (booleans as 1/0), or undefined for anything else. */
function numValue(a: AST.Expression | null | undefined): number | undefined {
  if (!a) return undefined;
  const e = unparen(a);
  if (e.type === "Literal") {
    if (typeof e.value === "number") return e.value;
    if (typeof e.value === "boolean") return e.value ? 1 : 0;
    return undefined;
  }
  if (e.type === "Identifier") {
    if (e.name === "true") return 1;
    if (e.name === "false") return 0;
    return undefined;
  }
  if (e.type === "UnaryExpression" && (e.operator === "-" || e.operator === "+")) {
    const v = numValue(e.argument);
    return v === undefined ? undefined : e.operator === "-" ? -v : v;
  }
  return undefined;
}

const isBool = (a: AST.Expression | null | undefined, b: boolean) => numValue(a) === (b ? 1 : 0);

export interface SetterFamily {
  code: string;
  name: string;
  /** Function names that change this state. */
  fns: readonly string[];
  /**
   * Getters: `var _old = draw_get_alpha(); ... draw_set_alpha(_old);` restores
   * the previous value, which counts as a reset (Feather's suggested fix).
   */
  getters: readonly string[];
  /** Part of the GPU state saved by gpu_push_state(). */
  gpu: boolean;
  /** The resetting call, as written in Feather's message. */
  reset: string;
  isDefault(args: Args): boolean;
}

export const SETTERS: readonly SetterFamily[] = [
  { code: "GM2000", name: "restore-blendmode", getters: ["gpu_get_blendmode"], fns: ["gpu_set_blendmode"], gpu: true, reset: "gpu_set_blendmode(bm_normal)", isDefault: (a) => isName(a[0], "bm_normal") },
  { code: "GM2019", name: "restore-valign", getters: ["draw_get_valign"], fns: ["draw_set_valign"], gpu: false, reset: "draw_set_valign(fa_top)", isDefault: (a) => isName(a[0], "fa_top") },
  { code: "GM2026", name: "restore-halign", getters: ["draw_get_halign"], fns: ["draw_set_halign"], gpu: false, reset: "draw_set_halign(fa_left)", isDefault: (a) => isName(a[0], "fa_left") },
  { code: "GM2048", name: "restore-blendenable", getters: ["gpu_get_blendenable"], fns: ["gpu_set_blendenable"], gpu: true, reset: "gpu_set_blendenable(true)", isDefault: (a) => isBool(a[0], true) },
  { code: "GM2049", name: "restore-zfunc", getters: ["gpu_get_zfunc"], fns: ["gpu_set_zfunc"], gpu: true, reset: "gpu_set_zfunc(cmpfunc_lessequal)", isDefault: (a) => isName(a[0], "cmpfunc_lessequal") },
  { code: "GM2050", name: "restore-fog", getters: ["gpu_get_fog"], fns: ["gpu_set_fog"], gpu: true, reset: "gpu_set_fog(false, c_black, 0, 1)", isDefault: (a) => isBool(a[0], false) },
  { code: "GM2051", name: "restore-cullmode", getters: ["gpu_get_cullmode"], fns: ["gpu_set_cullmode"], gpu: true, reset: "gpu_set_cullmode(cull_noculling)", isDefault: (a) => isName(a[0], "cull_noculling") },
  {
    code: "GM2052",
    name: "restore-colourwriteenable",
    getters: ["gpu_get_colourwriteenable", "gpu_get_colorwriteenable"],
    fns: ["gpu_set_colourwriteenable", "gpu_set_colorwriteenable"],
    gpu: true,
    reset: "gpu_set_colourwriteenable(true, true, true, true)",
    isDefault: (a) => {
      if (a.length >= 4) return a.slice(0, 4).every((x) => isBool(x, true));
      const arr = a[0] ? unparen(a[0]) : null;
      return arr?.type === "ArrayExpression" && arr.elements.length === 4 && arr.elements.every((x) => isBool(x, true));
    },
  },
  { code: "GM2053", name: "restore-alphatestenable", getters: ["gpu_get_alphatestenable"], fns: ["gpu_set_alphatestenable"], gpu: true, reset: "gpu_set_alphatestenable(false)", isDefault: (a) => isBool(a[0], false) },
  { code: "GM2054", name: "restore-alphatestref", getters: ["gpu_get_alphatestref"], fns: ["gpu_set_alphatestref"], gpu: true, reset: "gpu_set_alphatestref(0)", isDefault: (a) => numValue(a[0]) === 0 },
  { code: "GM2055", name: "restore-texfilter", getters: ["gpu_get_texfilter"], fns: ["gpu_set_texfilter"], gpu: true, reset: "gpu_set_texfilter(false)", isDefault: (a) => isBool(a[0], false) },
  { code: "GM2056", name: "restore-texrepeat", getters: ["gpu_get_texrepeat"], fns: ["gpu_set_texrepeat"], gpu: true, reset: "gpu_set_texrepeat(false)", isDefault: (a) => isBool(a[0], false) },
  {
    code: "GM2062",
    name: "restore-draw-colour",
    getters: ["draw_get_colour", "draw_get_color"],
    fns: ["draw_set_colour", "draw_set_color"],
    gpu: false,
    reset: "draw_set_colour(c_white)",
    isDefault: (a) => isName(a[0], "c_white") || numValue(a[0]) === 0xffffff,
  },
  { code: "GM2063", name: "restore-draw-alpha", getters: ["draw_get_alpha"], fns: ["draw_set_alpha"], gpu: false, reset: "draw_set_alpha(1)", isDefault: (a) => numValue(a[0]) === 1 },
];

export type PairName = "shader" | "surface" | "gpu" | "vertex" | "vformat" | "prim" | "ffind";

export interface PairFamily {
  pair: PairName;
  open: readonly string[];
  close: readonly string[];
  /** Functions only valid between open and close (single-depth pairs). */
  inside: readonly string[];
  /**
   * replace: re-opening just replaces; stack: nested; single: must not nest;
   * keyed: like single, but per first argument (vertex buffers are independent).
   */
  kind: "replace" | "stack" | "single" | "keyed";
  unclosed: { code: string; name: string; message: string };
  nested?: { code: string; name: string; message: string };
  unopened?: { code: string; name: string; message: string };
  outside?: { code: string; name: string; block: string };
  depth?: { code: string; name: string; message: string };
}

export const PAIRS: readonly PairFamily[] = [
  {
    pair: "shader",
    open: ["shader_set"],
    close: ["shader_reset"],
    inside: [],
    kind: "replace",
    unclosed: { code: "GM2003", name: "restore-shader", message: "Not all code paths call shader_reset() before end of script." },
  },
  {
    pair: "surface",
    open: ["surface_set_target", "surface_set_target_ext"],
    close: ["surface_reset_target"],
    inside: [],
    kind: "stack",
    unclosed: { code: "GM2005", name: "restore-surface-target", message: "Not all code paths call surface_reset_target() before end of script." },
    depth: {
      code: "GM2046",
      name: "consistent-surface-target-depth",
      message: "Inconsistent stack depth for surface_set_target()/surface_reset_target() blocks. All branches should call these functions the same number of times.",
    },
  },
  {
    pair: "gpu",
    open: ["gpu_push_state"],
    close: ["gpu_pop_state"],
    inside: [],
    kind: "stack",
    unclosed: { code: "GM2035", name: "restore-gpu-state", message: "Not all code paths call gpu_pop_state() before end of script." },
    depth: {
      code: "GM2042",
      name: "consistent-gpu-state-depth",
      message: "Inconsistent stack depth for gpu_push_state()/gpu_pop_state() blocks. All branches should call these functions an equal number of times.",
    },
  },
  {
    pair: "vertex",
    open: ["vertex_begin"],
    close: ["vertex_end"],
    inside: [
      "vertex_position", "vertex_position_3d", "vertex_colour", "vertex_color", "vertex_argb", "vertex_texcoord", "vertex_normal",
      "vertex_float1", "vertex_float2", "vertex_float3", "vertex_float4", "vertex_ubyte4",
    ],
    kind: "keyed",
    unclosed: { code: "GM2011", name: "close-vertex-batch", message: "Not all code paths call vertex_end() before the end of the script." },
    nested: { code: "GM2008", name: "no-nested-vertex-batch", message: "Opening another vertex batch before closing a previous vertex batch." },
    unopened: { code: "GM2009", name: "no-unopened-vertex-batch", message: "Closing a vertex batch without opening a vertex batch." },
    outside: { code: "GM2010", name: "vertex-inside-batch", block: "vertex_begin()/vertex_end()" },
  },
  {
    pair: "vformat",
    open: ["vertex_format_begin"],
    close: ["vertex_format_end"],
    inside: [
      "vertex_format_add_position", "vertex_format_add_position_3d", "vertex_format_add_colour", "vertex_format_add_color",
      "vertex_format_add_normal", "vertex_format_add_texcoord", "vertex_format_add_textcoord", "vertex_format_add_custom",
    ],
    kind: "single",
    unclosed: { code: "GM2015", name: "close-vertex-format", message: "Not all code paths call vertex_format_end() before the end of the script." },
    nested: { code: "GM2012", name: "no-nested-vertex-format", message: "Opening another vertex format before closing a previous vertex format." },
    unopened: { code: "GM2013", name: "no-unopened-vertex-format", message: "Closing a vertex format without opening a vertex format." },
    outside: { code: "GM2014", name: "vertex-format-add-inside-format", block: "vertex_format_begin()/vertex_format_end()" },
  },
  {
    pair: "prim",
    open: ["draw_primitive_begin", "draw_primitive_begin_texture"],
    close: ["draw_primitive_end"],
    inside: ["draw_vertex", "draw_vertex_colour", "draw_vertex_color", "draw_vertex_texture", "draw_vertex_texture_colour", "draw_vertex_texture_color"],
    kind: "single",
    unclosed: { code: "GM2030", name: "close-primitive", message: "Not all code paths call draw_primitive_end() before the end of the script." },
    nested: { code: "GM2027", name: "no-nested-primitive", message: "Opening another primitive before closing a previous primitive." },
    unopened: { code: "GM2028", name: "no-unopened-primitive", message: "Closing a primitive without opening a primitive." },
    outside: { code: "GM2029", name: "draw-vertex-inside-primitive", block: "draw_primitive_begin()/draw_primitive_end()" },
  },
  {
    pair: "ffind",
    open: ["file_find_first"],
    close: ["file_find_close"],
    inside: ["file_find_next"],
    kind: "single",
    unclosed: { code: "GM2034", name: "close-file-find", message: "Not all code paths call file_find_close() before the end of the script." },
    nested: { code: "GM2031", name: "no-nested-file-find", message: "Opening another File Find before closing a previous File Find." },
    unopened: { code: "GM2032", name: "no-unopened-file-find", message: "Closing a File Find without opening a File Find." },
    outside: { code: "GM2033", name: "file-find-inside-block", block: "file_find_first()/file_find_close()" },
  },
];

// ---------------------------------------------------------------------------
// Runs and ops
// ---------------------------------------------------------------------------

type Op =
  | { k: "set"; fam: number; dirty: boolean }
  | { k: "gpuState" } // gpu_set_state(struct): restores the whole GPU state
  | { k: "open" | "close" | "inside"; pair: number; name: string; key: number };

/**
 * A run tracks one family:
 *  - setter:    one non-GPU setter (value = dirtying call or -1)
 *  - gpuSetter: one GPU setter plus the gpu_push_state stack (pop restores it)
 *  - pair:      one open/close pair (value = open call, or a stack of them)
 */
type RunDef =
  | { kind: "setter"; fam: number }
  | { kind: "gpuSetter"; fam: number }
  | { kind: "pair"; pair: number };

const GPU_PAIR = PAIRS.findIndex((p) => p.pair === "gpu");
const RUNS: RunDef[] = [];
const SETTER_RUN: number[] = [];
const PAIR_RUN: number[] = [];
SETTERS.forEach((s, fam) => {
  SETTER_RUN[fam] = RUNS.length;
  RUNS.push(s.gpu ? { kind: "gpuSetter", fam } : { kind: "setter", fam });
});
PAIRS.forEach((_, pair) => {
  PAIR_RUN[pair] = RUNS.length;
  RUNS.push({ kind: "pair", pair });
});
const GPU_SETTER_BITS = SETTERS.reduce((m, s, fam) => (s.gpu ? m | (1 << SETTER_RUN[fam]!) : m), 0);
/** Marks nodes containing a jump (return/exit/throw/break/continue). */
const TERM = 1 << 30;
/** Marks statements containing an assignment / `var` (they invalidate condition facts). */
const ASSIGN = 1 << 29;

function opMask(op: Op): number {
  if (op.k === "set") return 1 << SETTER_RUN[op.fam]!;
  if (op.k === "gpuState") return GPU_SETTER_BITS;
  let m = 1 << PAIR_RUN[op.pair]!;
  if (op.pair === GPU_PAIR && (op.k === "open" || op.k === "close")) m |= GPU_SETTER_BITS;
  return m;
}

/**
 * `key` identifies the first argument's text (the vertex buffer of keyed
 * pairs); `saved` is the set of getters the first argument was assigned from.
 */
type MakeOp = (args: Args, key: number, saved: ReadonlySet<string> | undefined) => Op;
/** Tracked function name -> builder of its op. */
const TABLE = new Map<string, MakeOp>();
SETTERS.forEach((s, fam) => {
  const restores = (saved: ReadonlySet<string> | undefined) => !!saved && s.getters.some((g) => saved.has(g));
  for (const fn of s.fns) {
    TABLE.set(fn, (args, _, saved) => ({ k: "set", fam, dirty: !s.isDefault(args) && !restores(saved) }));
  }
});
const GETTERS = new Set(SETTERS.flatMap((s) => s.getters));
PAIRS.forEach((p, pair) => {
  for (const k of ["open", "close", "inside"] as const) {
    for (const fn of p[k]) TABLE.set(fn, (_, key) => ({ k, pair, name: fn, key }));
  }
});
TABLE.set("gpu_set_state", () => ({ k: "gpuState" }));

// ---------------------------------------------------------------------------
// Pre-pass: per-node run masks, tracked calls, bodies, condition atoms
// ---------------------------------------------------------------------------

/** A call-free condition atom: normalised text and the variables it reads. */
interface Atom {
  key: string;
  names: ReadonlySet<string>;
}

/** Condition text -> its truth on this path. */
type Facts = ReadonlyMap<string, { value: boolean; names: ReadonlySet<string> }>;

/** Variable an assignment writes (`a`, `o.a`, `a[i]` -> "a"). */
function targetName(e: AST.Expression): string | null {
  const x = unparen(e);
  if (x.type === "Identifier") return x.name;
  if (x.type === "MemberExpression") return x.property.name;
  if (x.type === "IndexExpression") return targetName(x.object);
  return null;
}

interface Body {
  stmts: AST.Statement[];
  mask: number;
  calls: AST.CallExpression[];
  /** Variable name -> state getters it was assigned from (`var _a = draw_get_alpha()`). */
  saved: Map<string, Set<string>>;
}

/**
 * One walk over the file: classifies tracked calls, splits the file into
 * bodies, and records for every node which runs (and TERM/ASSIGN) it touches.
 * Also answers condition-fact queries for the runs.
 */
class FileScan {
  readonly masks = new Map<AST.Node, number>();
  readonly ops = new Map<AST.CallExpression, Op>();
  readonly ids = new Map<AST.CallExpression, number>();
  readonly callList: AST.CallExpression[] = [];
  readonly bodies: Body[] = [];
  private readonly keys = new Map<string, number>();

  private readonly ctx: CheckContext;

  constructor(ctx: CheckContext) {
    this.ctx = ctx;
    const top: Body = { stmts: ctx.file.ast.body, mask: 0, calls: [], saved: new Map() };
    this.bodies.push(top);
    let m = 0;
    for (const s of ctx.file.ast.body) m |= this.scan(s, top);
    top.mask = m;
  }

  private scan(n: AST.Node, body: Body): number {
    if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression") {
      const b: Body = { stmts: n.body.body, mask: 0, calls: [], saved: new Map() };
      this.bodies.push(b);
      let m = 0;
      for (const c of childNodes(n)) m |= this.scan(c, b);
      b.mask = m;
      return 0;
    }
    let m = 0;
    for (const c of childNodes(n)) m |= this.scan(c, body);
    switch (n.type) {
      case "CallExpression": {
        const op = this.classify(n, body);
        if (op) {
          this.ops.set(n, op);
          this.ids.set(n, this.callList.length);
          this.callList.push(n);
          body.calls.push(n);
          m |= opMask(op);
        }
        break;
      }
      case "ReturnStatement":
      case "ExitStatement":
      case "ThrowStatement":
      case "BreakStatement":
      case "ContinueStatement":
        m |= TERM;
        break;
      case "VariableDeclaration":
        m |= ASSIGN;
        break;
      case "VariableDeclarator":
        if (n.init) this.recordSave(body, n.id.name, n.init);
        break;
      case "AssignmentExpression": {
        const left = unparen(n.left);
        if (n.operator === "=" && left.type === "Identifier") this.recordSave(body, left.name, n.right);
        break;
      }
      case "ExpressionStatement":
        if (n.expression.type === "AssignmentExpression" || n.expression.type === "UpdateExpression") m |= ASSIGN;
        break;
    }
    if (m) this.masks.set(n, m);
    return m;
  }

  // --- Branch conditions -------------------------------------------------
  //
  // An `if` test is split into atoms joined by `!`, `&&`/`and`, `||`/`or`.
  // An atom is a call-free expression over variables and literals
  // (`add`, `darken > 0`, `owner.glitch_fx > 0`, `state == State.TIRED`),
  // identified by its normalised text.

  private readonly atoms = new Map<AST.Expression, Atom | null>();

  private atom(x: AST.Expression): Atom | null {
    let a = this.atoms.get(x);
    if (a !== undefined) return a;
    const names = new Set<string>();
    const simple = (y: AST.Expression): boolean => {
      switch (y.type) {
        case "Identifier":
          names.add(y.name);
          return true;
        case "Literal":
          return true;
        case "ParenthesizedExpression":
          return simple(y.expression);
        case "UnaryExpression":
          return simple(y.argument);
        case "BinaryExpression":
        case "LogicalExpression":
          return simple(y.left) && simple(y.right);
        case "MemberExpression":
          names.add(y.property.name);
          return simple(y.object);
        case "IndexExpression":
          return simple(y.object) && y.indices.every(simple);
        default:
          return false;
      }
    };
    a = simple(x) && names.size > 0 ? { key: this.ctx.getText(x).replace(/\s+/g, ""), names } : null;
    this.atoms.set(x, a);
    return a;
  }

  private static split(e: AST.Expression): { op: "not"; arg: AST.Expression } | { op: "and" | "or"; left: AST.Expression; right: AST.Expression } | null {
    const x = unparen(e);
    if (x.type === "UnaryExpression" && (x.operator === "!" || x.operator === "not")) return { op: "not", arg: x.argument };
    if (x.type === "LogicalExpression") {
      if (x.operator === "&&" || x.operator === "and") return { op: "and", left: x.left, right: x.right };
      if (x.operator === "||" || x.operator === "or") return { op: "or", left: x.left, right: x.right };
    }
    return null;
  }

  /** Truth of a test given the facts on a path, when it follows from them. */
  known(e: AST.Expression, facts: Facts): boolean | undefined {
    const s = FileScan.split(e);
    if (s?.op === "not") {
      const v = this.known(s.arg, facts);
      return v === undefined ? undefined : !v;
    }
    if (s) {
      const l = this.known(s.left, facts);
      const r = this.known(s.right, facts);
      if (s.op === "and") return l === false || r === false ? false : l === true && r === true ? true : undefined;
      return l === true || r === true ? true : l === false && r === false ? false : undefined;
    }
    const a = this.atom(unparen(e));
    return a ? facts.get(a.key)?.value : undefined;
  }

  /** Facts implied by the test evaluating to `value`. */
  implied(e: AST.Expression, value: boolean, out: Array<[Atom, boolean]> = []): Array<[Atom, boolean]> {
    const s = FileScan.split(e);
    if (s?.op === "not") return this.implied(s.arg, !value, out);
    if (s) {
      // a && b true => both true; a || b false => both false; otherwise nothing definite.
      if ((s.op === "and") === value) {
        this.implied(s.left, value, out);
        this.implied(s.right, value, out);
      }
      return out;
    }
    const a = this.atom(unparen(e));
    if (a) out.push([a, value]);
    return out;
  }

  /** Variables read by the atoms of a test. */
  testNames(e: AST.Expression, out = new Set<string>()): Set<string> {
    const s = FileScan.split(e);
    if (s?.op === "not") this.testNames(s.arg, out);
    else if (s) {
      this.testNames(s.left, out);
      this.testNames(s.right, out);
    } else {
      for (const n of this.atom(unparen(e))?.names ?? []) out.add(n);
    }
    return out;
  }

  private readonly assignedCache = new Map<AST.Node, ReadonlySet<string>>();

  /** Names assigned anywhere in a statement (not counting nested functions). */
  assigned(n: AST.Node): ReadonlySet<string> {
    let s = this.assignedCache.get(n);
    if (s) return s;
    const out = new Set<string>();
    const visit = (x: AST.Node): void => {
      if (x.type === "FunctionDeclaration" || x.type === "FunctionExpression") return;
      // Only descend into nodes the pre-pass marked ASSIGN; update expressions
      // nested inside other expressions are not marked and are missed.
      if (!((this.masks.get(x) ?? 0) & ASSIGN) && x.type !== "AssignmentExpression" && x.type !== "UpdateExpression" && x.type !== "VariableDeclarator") return;
      if (x.type === "AssignmentExpression" || x.type === "UpdateExpression") {
        const t = targetName(x.type === "AssignmentExpression" ? x.left : x.argument);
        if (t) out.add(t);
      } else if (x.type === "VariableDeclarator") {
        out.add(x.id.name);
      }
      for (const c of childNodes(x)) visit(c);
    };
    visit(n);
    s = out;
    this.assignedCache.set(n, s);
    return s;
  }

  private recordSave(body: Body, name: string, value: AST.Expression): void {
    const v = unparen(value);
    if (v.type !== "CallExpression") return;
    const callee = unparen(v.callee);
    if (callee.type !== "Identifier" || !GETTERS.has(callee.name)) return;
    if (this.ctx.checker.spec && this.ctx.fc.resolve(callee)?.kind !== "builtin-function") return;
    let s = body.saved.get(name);
    if (!s) body.saved.set(name, (s = new Set()));
    s.add(callee.name);
  }

  private classify(call: AST.CallExpression, body: Body): Op | null {
    const callee = unparen(call.callee);
    if (callee.type !== "Identifier") return null;
    const make = TABLE.get(callee.name);
    if (!make) return null;
    if (this.ctx.checker.spec && this.ctx.fc.resolve(callee)?.kind !== "builtin-function") return null;
    const a0 = call.arguments[0];
    let key = -1;
    if (a0) {
      const text = this.ctx.getText(a0).replace(/\s+/g, "");
      key = this.keys.get(text) ?? this.keys.size;
      this.keys.set(text, key);
    }
    const id = a0 ? unparen(a0) : null;
    return make(call.arguments, key, id?.type === "Identifier" ? body.saved.get(id.name) : undefined);
  }
}

// ---------------------------------------------------------------------------
// Abstract interpretation of one body for one run
// ---------------------------------------------------------------------------

/** The tracked state on one path. */
interface PathState {
  /** Setter: dirtying call id. Pair (replace/single): open call id. -1 = clean/closed. */
  readonly v: number;
  /** Stack pairs: open call ids. gpuSetter: [push id, saved v]. keyed: [open id, buffer key]. */
  readonly stack: ReadonlyArray<readonly [number, number]>;
  /**
   * Branch conditions known on this path, so `if (c) set(); ...; if (c) reset();`
   * is understood. Not part of the key: states merge by intersecting facts.
   */
  readonly facts: Facts | null;
  readonly key: string;
}

function makeState(v: number, stack: ReadonlyArray<readonly [number, number]>, facts: Facts | null): PathState {
  let key = String(v);
  for (const e of stack) key += `|${e[0]}:${e[1]}`;
  return { v, stack, facts, key };
}

const withFacts = (s: PathState, facts: Facts | null): PathState => (facts === s.facts ? s : { ...s, facts });

function intersectFacts(a: Facts | null, b: Facts | null): Facts | null {
  if (!a || !b) return null;
  if (a === b) return a;
  let out: Map<string, { value: boolean; names: ReadonlySet<string> }> | null = null;
  for (const [k, f] of a) {
    if (b.get(k)?.value === f.value) (out ??= new Map()).set(k, f);
  }
  if (!out) return null;
  return out.size === a.size ? a : out;
}

/** States leaving a statement: falling through, via `break`, via `continue`. */
interface Out {
  normal: PathState[];
  brk: PathState[];
  cont: PathState[];
}

const MAX_STATES = 64;
const MAX_STACK = 16;
const MAX_STEPS = 200_000;
/** Loop bodies run until their entry states repeat, at most this many times. */
const MAX_ITERATIONS = 4;
/** Run.flags bits: the pair was open / closed when a call was reached. */
const FLAG_OPEN = 1;
const FLAG_CLOSED = 2;

/** Too many states or steps: the run is abandoned and reports nothing. */
class Overflow extends Error {}

class Run {
  /** This run's bit in the node masks. */
  private readonly bit: number;
  /** Mask bits that make a statement worth visiting. */
  private readonly sel: number;
  private steps = 0;
  /** Call ids that reach the end of the body unrestored/unclosed. */
  readonly unclosed = new Set<number>();
  /** Per call id: whether the family was open/closed when it was reached. */
  readonly flags = new Map<number, number>();
  /** Branching constructs whose branches end with different stack depths. */
  readonly inconsistent = new Set<AST.Node>();
  private readonly pair: PairFamily | null;
  private readonly scan: FileScan;
  private readonly def: RunDef;

  constructor(scan: FileScan, runIndex: number, def: RunDef) {
    this.scan = scan;
    this.def = def;
    this.bit = 1 << runIndex;
    this.sel = this.bit | TERM;
    this.pair = def.kind === "pair" ? PAIRS[def.pair]! : null;
  }

  run(body: Body): boolean {
    try {
      const o = this.list(body.stmts, [makeState(-1, [], null)]);
      this.finish(this.union(o.normal, o.brk, o.cont));
      return true;
    } catch (e) {
      if (e instanceof Overflow) return false;
      throw e;
    }
  }

  private union(...lists: PathState[][]): PathState[] {
    if (lists.length === 1 && lists[0]!.length <= 1) return lists[0]!;
    const seen = new Map<string, PathState>();
    for (const l of lists) {
      for (const s of l) {
        const prev = seen.get(s.key);
        if (!prev) seen.set(s.key, s);
        else if (prev.facts && prev !== s) seen.set(s.key, withFacts(prev, intersectFacts(prev.facts, s.facts)));
      }
    }
    if (seen.size > MAX_STATES) throw new Overflow();
    return [...seen.values()];
  }

  /** Selector for a statement: assignments only matter while some path knows a condition. */
  private selFor(states: PathState[]): number {
    for (const s of states) if (s.facts) return this.sel | ASSIGN;
    return this.sel;
  }

  /** Forgets conditions that read any of `names`. */
  private kill(states: PathState[], names: Iterable<string>): PathState[] {
    let out: PathState[] | null = null;
    const list = [...names];
    states.forEach((s, i) => {
      if (!s.facts) return;
      let f: Map<string, { value: boolean; names: ReadonlySet<string> }> | null = null;
      for (const [k, fact] of s.facts) {
        if (list.some((n) => fact.names.has(n))) {
          f ??= new Map(s.facts);
          f.delete(k);
        }
      }
      if (f) (out ??= [...states])[i] = withFacts(s, f.size ? f : null);
    });
    return out ? this.union(out) : states;
  }

  private assume(o: Out, facts: Array<[Atom, boolean]>): Out {
    if (facts.length === 0) return o;
    const add = (s: PathState) => {
      const m = new Map(s.facts ?? []);
      for (const [a, value] of facts) m.set(a.key, { value, names: a.names });
      return withFacts(s, m);
    };
    return { normal: o.normal.map(add), brk: o.brk.map(add), cont: o.cont.map(add) };
  }

  private static sameKeys(a: PathState[], b: PathState[]): boolean {
    if (a.length !== b.length) return false;
    const ka = new Set(a.map((s) => s.key));
    return b.every((s) => ka.has(s.key));
  }

  private tick(): void {
    if (++this.steps > MAX_STEPS) throw new Overflow();
  }

  private finish(states: PathState[]): void {
    const stackPair = this.pair?.kind === "stack" || this.pair?.kind === "keyed";
    for (const s of states) {
      if (stackPair) for (const e of s.stack) this.unclosed.add(e[0]);
      else if (s.v >= 0) this.unclosed.add(s.v);
    }
  }

  private compare(node: AST.Node, groups: PathState[][]): void {
    if (!this.pair?.depth) return;
    let first: string | null = null;
    for (const g of groups) {
      if (g.length === 0) continue;
      const depths = [...new Set(g.map((s) => s.stack.length))].sort((a, b) => a - b).join(",");
      if (first === null) first = depths;
      else if (first !== depths) {
        this.inconsistent.add(node);
        return;
      }
    }
  }

  private list(stmts: readonly AST.Statement[], ins: PathState[]): Out {
    let cur = ins;
    const brk: PathState[] = [];
    const cont: PathState[] = [];
    for (const s of stmts) {
      if (cur.length === 0) break;
      if (!((this.scan.masks.get(s) ?? 0) & this.selFor(cur))) continue;
      const o = this.stmt(s, cur);
      brk.push(...o.brk);
      cont.push(...o.cont);
      cur = o.normal;
    }
    return { normal: cur, brk, cont };
  }

  private stmt(s: AST.Statement, ins: PathState[]): Out {
    if (ins.length === 0 || !((this.scan.masks.get(s) ?? 0) & this.selFor(ins))) return { normal: ins, brk: [], cont: [] };
    this.tick();
    switch (s.type) {
      case "BlockStatement":
        return this.list(s.body, ins);
      case "ExpressionStatement": {
        let cur = this.expr(s.expression, ins);
        const x = s.expression;
        if (x.type === "AssignmentExpression" || x.type === "UpdateExpression") {
          const t = targetName(x.type === "AssignmentExpression" ? x.left : x.argument);
          if (t) cur = this.kill(cur, [t]);
        }
        return { normal: cur, brk: [], cont: [] };
      }
      case "VariableDeclaration": {
        let cur = ins;
        for (const d of s.declarations) if (d.init) cur = this.expr(d.init, cur);
        cur = this.kill(cur, s.declarations.map((d) => d.id.name));
        return { normal: cur, brk: [], cont: [] };
      }
      case "DeleteStatement":
        return { normal: this.expr(s.argument, ins), brk: [], cont: [] };
      case "IfStatement": {
        const out: Out = { normal: [], brk: [], cont: [] };
        const skip = (st: PathState): Out => ({ normal: [st], brk: [], cont: [] });
        for (const st of this.expr(s.test, ins)) {
          const known = st.facts ? this.scan.known(s.test, st.facts) : undefined;
          if (known !== undefined) {
            // Follows from conditions tested earlier on this path: one branch only.
            const o = known ? this.stmt(s.consequent, [st]) : s.alternate ? this.stmt(s.alternate, [st]) : skip(st);
            out.normal.push(...o.normal);
            out.brk.push(...o.brk);
            out.cont.push(...o.cont);
            continue;
          }
          let c = this.stmt(s.consequent, [st]);
          let a = s.alternate ? this.stmt(s.alternate, [st]) : skip(st);
          this.compare(s, [c.normal, a.normal]);
          // Remember the condition when the branches diverged, unless the
          // statement itself changes what the condition reads.
          if (!Run.sameKeys(c.normal, a.normal)) {
            const assigned = this.scan.assigned(s);
            if (![...this.scan.testNames(s.test)].some((n) => assigned.has(n))) {
              c = this.assume(c, this.scan.implied(s.test, true));
              a = this.assume(a, this.scan.implied(s.test, false));
            }
          }
          out.normal.push(...c.normal, ...a.normal);
          out.brk.push(...c.brk, ...a.brk);
          out.cont.push(...c.cont, ...a.cont);
        }
        return this.dedupe(out);
      }
      case "WhileStatement":
      case "ForStatement":
      case "RepeatStatement":
      case "WithStatement":
        return this.loop(s, ins);
      case "DoUntilStatement":
        return { normal: this.iterate(s.body, ins, (after) => this.expr(s.test, after)), brk: [], cont: [] };
      case "SwitchStatement":
        return this.switch(s, ins);
      case "BreakStatement":
        return { normal: [], brk: ins, cont: [] };
      case "ContinueStatement":
        return { normal: [], brk: [], cont: ins };
      case "ReturnStatement":
        this.finish(s.argument ? this.expr(s.argument, ins) : ins);
        return { normal: [], brk: [], cont: [] };
      case "ExitStatement":
        this.finish(ins);
        return { normal: [], brk: [], cont: [] };
      case "ThrowStatement":
        this.expr(s.argument, ins); // the path ends; leaving state set is fine
        return { normal: [], brk: [], cont: [] };
      case "TryStatement": {
        const b = this.stmt(s.block, ins);
        const out: Out = { normal: b.normal, brk: b.brk, cont: b.cont };
        if (s.handler) {
          // The exception may be raised anywhere in the block: approximate with
          // its entry and exit states.
          const h = this.stmt(s.handler.body, this.union(ins, b.normal));
          out.normal = this.union(out.normal, h.normal);
          out.brk.push(...h.brk);
          out.cont.push(...h.cont);
        }
        if (s.finalizer) {
          const f = this.stmt(s.finalizer, out.normal);
          out.normal = f.normal;
          out.brk.push(...f.brk);
          out.cont.push(...f.cont);
        }
        return this.dedupe(out);
      }
      default:
        return { normal: ins, brk: [], cont: [] };
    }
  }

  private dedupe(o: Out): Out {
    return { normal: this.union(o.normal), brk: this.union(o.brk), cont: this.union(o.cont) };
  }

  private loop(s: AST.WhileStatement | AST.ForStatement | AST.RepeatStatement | AST.WithStatement, ins: PathState[]): Out {
    let entry: PathState[];
    let test: AST.Expression | null = null;
    let update: AST.ExpressionStatement | null = null;
    if (s.type === "WhileStatement") {
      test = s.test;
      entry = this.expr(s.test, ins);
    } else if (s.type === "ForStatement") {
      entry = s.init ? this.stmt(s.init, ins).normal : ins;
      test = s.test;
      update = s.update;
      if (test) entry = this.expr(test, entry);
    } else if (s.type === "RepeatStatement") {
      entry = this.expr(s.count, ins);
    } else {
      entry = this.expr(s.object, ins);
    }
    const normal: PathState[] = [];
    const next = (after: PathState[]) => {
      let again = after;
      if (update) again = this.stmt(update, again).normal;
      if (test) again = this.expr(test, again);
      return again;
    };
    for (const st of entry) {
      if (s.type !== "WithStatement") {
        normal.push(...this.iterate(s.body, [st], next, s));
        continue;
      }
      // Conditions inside `with` read another instance's variables: run the
      // body without facts, then restore the outer ones it cannot have changed.
      const exits = this.iterate(s.body, [withFacts(st, null)], next, s);
      const outer = st.facts ? this.kill([st], this.scan.assigned(s.body))[0]!.facts : null;
      normal.push(...exits.map((x) => withFacts(x, outer)));
    }
    return { normal: this.union(normal), brk: [], cont: [] };
  }

  /**
   * Runs a loop body from `heads` (states at the top of the body), feeding the
   * states that come back around (`next`: update + test) into further
   * iterations until no new state appears (bounded). Returns the states
   * leaving the loop. With `compareAt`, compares stack depths of "zero
   * iterations" and "one iteration".
   */
  private iterate(body: AST.Statement, heads: PathState[], next: (after: PathState[]) => PathState[], compareAt?: AST.Node): PathState[] {
    const seen = new Set(heads.map((h) => h.key));
    const exits: PathState[] = compareAt ? [...heads] : [];
    let frontier = heads;
    for (let i = 0; i < MAX_ITERATIONS && frontier.length; i++) {
      const b = this.stmt(body, frontier);
      const again = next(this.union(b.normal, b.cont));
      if (i === 0 && compareAt) this.compare(compareAt, [heads, this.union(again, b.brk)]);
      exits.push(...again, ...b.brk);
      frontier = again.filter((x) => !seen.has(x.key));
      for (const x of frontier) seen.add(x.key);
    }
    return this.union(exits);
  }

  private switch(s: AST.SwitchStatement, ins: PathState[]): Out {
    const hasDefault = s.cases.some((c) => c.test === null);
    const normal: PathState[] = [];
    const cont: PathState[] = [];
    for (const st of this.expr(s.discriminant, ins)) {
      const groups: PathState[][] = [];
      let fall: PathState[] = [];
      for (const c of s.cases) {
        const o = this.list(c.consequent, this.union([st], fall));
        if (o.brk.length) groups.push(o.brk);
        normal.push(...o.brk);
        cont.push(...o.cont);
        fall = o.normal;
      }
      if (fall.length) groups.push(fall);
      normal.push(...fall);
      if (!hasDefault) {
        groups.push([st]);
        normal.push(st);
      }
      this.compare(s, groups);
    }
    return { normal: this.union(normal), brk: [], cont: this.union(cont) };
  }

  private expr(e: AST.Expression | AST.AssignmentExpression, ins: PathState[]): PathState[] {
    if (ins.length === 0 || !((this.scan.masks.get(e) ?? 0) & this.bit)) return ins;
    this.tick();
    switch (e.type) {
      case "LogicalExpression": {
        const l = this.expr(e.left, ins);
        return this.union(l, this.expr(e.right, l));
      }
      case "ConditionalExpression": {
        const t = this.expr(e.test, ins);
        return this.union(this.expr(e.consequent, t), this.expr(e.alternate, t));
      }
      case "FunctionExpression":
        return ins;
      default: {
        let cur = ins;
        for (const c of childNodes(e)) cur = this.expr(c as AST.Expression, cur);
        if (e.type === "CallExpression") {
          const op = this.scan.ops.get(e);
          if (op) cur = this.apply(op, this.scan.ids.get(e)!, cur);
        }
        return cur;
      }
    }
  }

  private flag(id: number, open: boolean): void {
    this.flags.set(id, (this.flags.get(id) ?? 0) | (open ? FLAG_OPEN : FLAG_CLOSED));
  }

  private apply(op: Op, id: number, ins: PathState[]): PathState[] {
    if (!(opMask(op) & this.bit)) return ins;
    const def = this.def;
    const out: PathState[] = [];
    for (const s of ins) {
      let v = s.v;
      let stack = s.stack;
      if (def.kind === "setter" || def.kind === "gpuSetter") {
        if (op.k === "set") {
          if (op.fam === def.fam) v = op.dirty ? id : -1;
        } else if (op.k === "gpuState") {
          v = -1;
        } else if (def.kind === "gpuSetter" && op.pair === GPU_PAIR) {
          if (op.k === "open") {
            if (stack.length >= MAX_STACK) throw new Overflow();
            stack = [...stack, [id, v]];
          } else if (op.k === "close") {
            // Popping restores the state saved by the matching push; a pop
            // without a push here restores state pushed by other code.
            v = stack.length ? stack[stack.length - 1]![1] : -1;
            stack = stack.slice(0, -1);
          }
        }
      } else {
        if (op.k === "set" || op.k === "gpuState") {
          out.push(s); // not reached: filtered by the mask
          continue;
        }
        const kind = this.pair!.kind;
        if (kind === "replace") {
          if (op.k === "open") v = id;
          else if (op.k === "close") v = -1;
        } else if (kind === "stack") {
          if (op.k === "open") {
            if (stack.length >= MAX_STACK) throw new Overflow();
            stack = [...stack, [id, -1]];
          } else if (op.k === "close") {
            stack = stack.slice(0, -1);
          }
        } else if (kind === "keyed") {
          // Open batches as [open call id, buffer key], sorted by key.
          const i = stack.findIndex((e) => e[1] === op.key);
          if (op.k === "open") {
            this.flag(id, i >= 0);
            if (stack.length >= MAX_STACK) throw new Overflow();
            const rest = i >= 0 ? stack.filter((_, j) => j !== i) : stack;
            stack = [...rest, [id, op.key] as const].sort((a, b) => a[1] - b[1]);
          } else if (op.k === "close") {
            // A different buffer expression may still name the open buffer:
            // close the latest batch rather than calling it unopened.
            this.flag(id, stack.length > 0);
            if (i >= 0) stack = stack.filter((_, j) => j !== i);
            else if (stack.length) stack = stack.slice(0, -1);
          } else {
            this.flag(id, stack.length > 0);
          }
        } else {
          this.flag(id, v >= 0);
          if (op.k === "open") v = id;
          else if (op.k === "close") v = -1;
        }
      }
      out.push(v === s.v && stack === s.stack ? s : makeState(v, stack, s.facts));
    }
    return this.union(out);
  }
}

// ---------------------------------------------------------------------------
// File analysis (cached)
// ---------------------------------------------------------------------------

const KEYWORD_LENGTH: Partial<Record<AST.NodeType, number>> = {
  IfStatement: 2,
  SwitchStatement: 6,
  WhileStatement: 5,
  DoUntilStatement: 2,
  RepeatStatement: 6,
  ForStatement: 3,
  WithStatement: 4,
};

/** GM2042/GM2046 underline the construct's keyword. */
function keywordRange(node: AST.Node): AST.Range {
  const len = KEYWORD_LENGTH[node.type];
  if (len === undefined || node.fromMacro) return node.range;
  return [node.range[0], node.range[0] + len];
}

const NAME_SOURCE = [...TABLE.keys()].join("|");
const NAME_RE = new RegExp(`\\b(?:${NAME_SOURCE})\\b`);
const relevantText = new WeakMap<object, RegExp>();

/**
 * Text pre-filter: files that mention no tracked function (directly or via a
 * macro whose body does) are skipped without walking the AST.
 */
function mentionsTrackedFunction(ctx: CheckContext): boolean {
  let re = relevantText.get(ctx.checker);
  if (!re) {
    const macros: string[] = [];
    for (const [name, decls] of ctx.checker.binding.macros) {
      if (decls.some((d) => NAME_RE.test(d.node.value))) macros.push(name);
    }
    re = macros.length ? new RegExp(`\\b(?:${NAME_SOURCE}|${macros.join("|")})\\b`) : NAME_RE;
    relevantText.set(ctx.checker, re);
  }
  return re.test(ctx.file.text);
}

function analyzeFile(ctx: CheckContext): Map<string, StateFinding[]> {
  const byCode = new Map<string, StateFinding[]>();
  if (!mentionsTrackedFunction(ctx)) return byCode;
  const scan = new FileScan(ctx);
  if (scan.callList.length === 0) return byCode;
  const add = (code: string, range: AST.Range, message: string) => {
    let l = byCode.get(code);
    if (!l) byCode.set(code, (l = []));
    l.push({ code, range, message });
  };
  const callOf = (id: number) => scan.callList[id]!;

  for (const body of scan.bodies) {
    if (!(body.mask & ~TERM)) continue;
    RUNS.forEach((def, i) => {
      if (!(body.mask & (1 << i))) return;
      const run = new Run(scan, i, def);
      if (!run.run(body)) return; // too many paths: stay silent

      if (def.kind !== "pair") {
        const fam = SETTERS[def.fam]!;
        const msg = `Not all code paths call ${fam.reset} before the end of the script.`;
        for (const id of run.unclosed) add(fam.code, callOf(id).range, msg);
        return;
      }
      const p = PAIRS[def.pair]!;
      for (const id of run.unclosed) add(p.unclosed.code, callOf(id).range, p.unclosed.message);

      if (p.kind === "single" || p.kind === "keyed") {
        const hasOpen = body.calls.some((c) => {
          const op = scan.ops.get(c)!;
          return op.k === "open" && op.pair === def.pair;
        });
        for (const c of body.calls) {
          const op = scan.ops.get(c)!;
          if (op.k === "set" || op.k === "gpuState" || op.pair !== def.pair) continue;
          const f = run.flags.get(scan.ids.get(c)!);
          if (f === undefined) continue; // unreachable
          if (op.k === "open") {
            if (!(f & FLAG_CLOSED) && p.nested) add(p.nested.code, c.range, p.nested.message);
          } else if (!(f & FLAG_OPEN) && hasOpen) {
            // Only when this body manages the block itself: helpers that write
            // vertices or close a batch opened by their caller are fine.
            if (op.k === "close" && p.unopened) add(p.unopened.code, c.range, p.unopened.message);
            if (op.k === "inside" && p.outside) {
              add(p.outside.code, c.range, `The function '${op.name}' cannot be called outside of a ${p.outside.block} block.`);
            }
          }
        }
      }

      if (p.depth && run.inconsistent.size) {
        const nodes = [...run.inconsistent];
        for (const n of nodes) {
          // Report the innermost inconsistent construct only.
          const containsOther = nodes.some((o) => o !== n && o.range[0] >= n.range[0] && o.range[1] <= n.range[1]);
          if (!containsOther) add(p.depth.code, keywordRange(n), p.depth.message);
        }
      }
    });
  }
  for (const l of byCode.values()) l.sort((a, b) => a.range[0] - b.range[0]);
  return byCode;
}

const cache = new WeakMap<AST.Program, { checker: object; result: Map<string, StateFinding[]> }>();

/** All state findings for the context's file, computed once and shared by every state check. */
export function stateFindings(ctx: CheckContext): Map<string, StateFinding[]> {
  const ast = ctx.file.ast;
  const hit = cache.get(ast);
  if (hit && hit.checker === ctx.checker) return hit.result;
  const result = analyzeFile(ctx);
  cache.set(ast, { checker: ctx.checker, result });
  return result;
}
