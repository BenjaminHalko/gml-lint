/** Helpers shared by the semantic checks. */

import type * as AST from "@gml-lint/parser";
import type { EventInfo } from "@gml-lint/project";
import type { Write } from "../../binder.js";
import type { Checker } from "../../checker.js";
import type { Type } from "../../types.js";

export { docs } from "../syntax/helpers.js";

export const KEYWORD_NAMES: ReadonlySet<string> = new Set(["self", "other", "global", "all", "noone"]);

/** The expression written to by an assignment (any operator) or `++`/`--`. */
export function writeTarget(node: AST.AssignmentExpression | AST.UpdateExpression): AST.Expression {
  return node.type === "AssignmentExpression" ? node.left : node.argument;
}

/** Plain (declaring) assignment operators. */
export function isDeclaringOperator(op: AST.AssignmentOperator): boolean {
  return op === "=" || op === ":=" || op === "??=";
}

/** Whether every member of `t` (a union or a single type) has one of `kinds`. Unknown/any never qualify. */
export function isDefinitely(t: Type, kinds: ReadonlySet<Type["kind"]>): boolean {
  if (t.kind === "union") return t.types.length > 0 && t.types.every((m) => isDefinitely(m, kinds));
  return kinds.has(t.kind);
}

export function isCreateEvent(e: EventInfo | null | undefined): boolean {
  return e?.type === "Create" || e?.type === "PreCreate";
}

/** The earliest write by file path, then offset. */
export function firstWrite(writes: Iterable<Write>): Write | undefined {
  let best: Write | undefined;
  for (const w of writes) {
    if (!best || w.file.path < best.file.path || (w.file.path === best.file.path && w.nameNode.range[0] < best.nameNode.range[0])) best = w;
  }
  return best;
}

const childrenCache = new WeakMap<Checker, Map<string, string[]>>();

/** Every descendant of `object` (children, grandchildren, ...). */
export function descendants(checker: Checker, object: string): string[] {
  let children = childrenCache.get(checker);
  if (!children) {
    children = new Map();
    for (const o of checker.project?.objects.values() ?? []) {
      if (!o.parent) continue;
      let list = children.get(o.parent);
      if (!list) children.set(o.parent, (list = []));
      list.push(o.name);
    }
    childrenCache.set(checker, children);
  }
  const out: string[] = [];
  const seen = new Set<string>([object]);
  const stack = [object];
  while (stack.length) {
    for (const c of children.get(stack.pop()!) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      stack.push(c);
    }
  }
  return out;
}

const memberNameCache = new WeakMap<Checker, Set<string>>();

/** Names written as a variable anywhere: on objects, constructors, globals, or unknown targets. */
export function writtenMemberNames(checker: Checker): Set<string> {
  let names = memberNameCache.get(checker);
  if (!names) {
    const b = checker.binding;
    names = new Set(b.unknownTargetWrites);
    for (const vars of b.objectVars.values()) for (const n of vars.keys()) names.add(n);
    for (const c of b.constructors.values()) {
      for (const n of c.fields.keys()) names.add(n);
      for (const n of c.statics.keys()) names.add(n);
    }
    for (const n of b.globals.keys()) names.add(n);
    memberNameCache.set(checker, names);
  }
  return names;
}

/** Whether a node is inside `range` (inclusive start, exclusive end). */
export function within(node: { range: AST.Range }, range: AST.Range): boolean {
  return node.range[0] >= range[0] && node.range[1] <= range[1];
}
