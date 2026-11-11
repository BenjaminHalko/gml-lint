/**
 * Object-event rules: GM2016 (instance variable first declared outside the
 * Create event), GM2025 (user event that does not exist) and GM2040
 * (`event_inherited()` with no parent event).
 */

import type * as AST from "@gml-lint/parser";
import type { EventInfo } from "@gml-lint/project";
import type { Checker } from "../../checker.js";
import { defineCheck } from "../api.js";
import { unparen } from "../util.js";
import { descendants, docs, firstWrite, isCreateEvent } from "./shared.js";

// ---------------------------------------------------------------------------
// GM2016
// ---------------------------------------------------------------------------

/** Whether some write or Variable Definition declares `name` up front for `object`. */
function declaredUpFront(checker: Checker, object: string, name: string): boolean {
  const project = checker.project;
  for (const o of [...checker.objectChain(object), ...descendants(checker, object)]) {
    if (project?.objects.get(o)?.properties.some((p) => p.name === name)) return true;
    for (const w of checker.binding.objectVars.get(o)?.get(name) ?? []) {
      if (w.inCreate || isCreateEvent(w.event)) return true;
    }
  }
  return false;
}

/** Every write to `name` on the object chain is a direct write in one of the chain's own event files. */
function onlyDirectEventWrites(checker: Checker, object: string, name: string): boolean {
  const chain = new Set(checker.objectChain(object));
  for (const o of chain) {
    for (const w of checker.binding.objectVars.get(o)?.get(name) ?? []) {
      const gml = w.file.gml;
      if (!w.direct || gml?.kind !== "event" || !chain.has(gml.owner)) return false;
    }
  }
  return true;
}

export const GM2016 = defineCheck({
  meta: {
    code: "GM2016",
    name: "instance-variable-outside-create",
    description: "Instance variable declared outside of Create event, declare with 'var' or move to Create event.",
    category: "semantic",
    feather: true,
    docs: docs("GM2016"),
  },
  create(ctx) {
    const gml = ctx.file.gml;
    const c = ctx.checker;
    if (gml?.kind !== "event" || !gml.event || isCreateEvent(gml.event) || !c.project) return {};
    const owner = gml.owner;
    return {
      Program() {
        const vars = c.binding.objectVars.get(owner);
        if (!vars || c.objectIsDynamic(owner)) return;
        for (const [name, writes] of vars) {
          if (c.spec?.variables.has(name) || c.binding.unknownTargetWrites.has(name)) continue;
          const own = writes.filter((w) => w.file.gml?.kind === "event" && w.file.gml.owner === owner);
          const first = firstWrite(own);
          if (!first || first.file !== ctx.file || first.nameNode.type !== "Identifier") continue;
          if (declaredUpFront(c, owner, name) || !onlyDirectEventWrites(c, owner, name)) continue;
          // Must really be an instance variable at that point (not an asset/macro/local name).
          if (ctx.fc.resolveName(name, first.nameNode).kind !== "instance-var") continue;
          ctx.report({
            node: first.nameNode,
            message: `Instance variable '${name}' declared outside of Create event, declare with 'var' or move to Create event.`,
          });
        }
      },
    };
  },
});

// ---------------------------------------------------------------------------
// GM2025
// ---------------------------------------------------------------------------

/** Whether `object`, an ancestor, or a descendant (which may run inherited code) defines the event. */
function eventDefinedAround(checker: Checker, object: string, match: (e: EventInfo) => boolean): boolean | null {
  const project = checker.project;
  if (!project) return null;
  for (const o of [...checker.objectChain(object), ...descendants(checker, object)]) {
    const res = project.objects.get(o);
    if (!res) return null; // broken parent chain: don't guess
    if (res.events.some(match)) return true;
  }
  return false;
}

function userEventNumber(e: AST.Expression | null | undefined): number | null {
  if (!e) return null;
  e = unparen(e);
  if (e.type === "Literal" && e.kind === "real" && typeof e.value === "number" && Number.isInteger(e.value) && e.value >= 0 && e.value <= 15) return e.value;
  if (e.type === "Identifier") {
    const m = /^ev_user(\d{1,2})$/.exec(e.name);
    if (m && Number(m[1]) <= 15) return Number(m[1]);
  }
  return null;
}

export const GM2025 = defineCheck({
  meta: {
    code: "GM2025",
    name: "no-undefined-event",
    description: "Reference to non-existent event.",
    category: "semantic",
    feather: true,
    docs: docs("GM2025"),
  },
  create(ctx) {
    const c = ctx.checker;
    if (!c.project) return {};
    return {
      CallExpression(node) {
        const callee = unparen(node.callee);
        if (callee.type !== "Identifier") return;
        const name = callee.name;
        if (name !== "event_user" && name !== "event_perform" && name !== "event_perform_object") return;
        if (ctx.fc.resolve(callee)?.kind !== "builtin-function") return;
        let object: string | null = null;
        let n: number | null = null;
        if (name === "event_user") {
          if (node.arguments.length !== 1) return;
          n = userEventNumber(node.arguments[0]);
          const self = ctx.fc.selfAt(node);
          object = self.kind === "object" ? self.object : null;
        } else {
          const [objArg, typeArg, numArg] = name === "event_perform" ? [null, ...node.arguments] : node.arguments;
          const t = typeArg ? unparen(typeArg) : null;
          if (t?.type !== "Identifier" || t.name !== "ev_other") return;
          n = userEventNumber(numArg);
          if (numArg && unparen(numArg).type === "Literal") n = null; // ev_other numbers other than ev_userN are other events
          if (objArg) {
            const o = unparen(objArg);
            object = o.type === "Identifier" && ctx.fc.resolve(o)?.kind === "asset" && c.isObject(o.name) ? o.name : null;
          } else {
            const self = ctx.fc.selfAt(node);
            object = self.kind === "object" ? self.object : null;
          }
        }
        if (n === null || object === null) return;
        const num = 10 + n;
        if (eventDefinedAround(c, object, (e) => e.type === "Other" && e.number === num) !== false) return;
        ctx.report({ node, message: `Reference to non-existent event 'User Event ${n}'.` });
      },
    };
  },
});

// ---------------------------------------------------------------------------
// GM2040
// ---------------------------------------------------------------------------

export const GM2040 = defineCheck({
  meta: {
    code: "GM2040",
    name: "no-event-inherited-without-parent-event",
    description: "Call to event_inherited() in object with no parent event.",
    category: "semantic",
    feather: true,
    docs: docs("GM2040"),
  },
  create(ctx) {
    const gml = ctx.file.gml;
    const c = ctx.checker;
    const project = c.project;
    if (gml?.kind !== "event" || !gml.event || !project) return {};
    const ev = gml.event;
    return {
      CallExpression(node) {
        const callee = unparen(node.callee);
        if (callee.type !== "Identifier" || callee.name !== "event_inherited") return;
        if (ctx.fc.resolve(callee)?.kind !== "builtin-function") return;
        // Only where the running event is certainly this file's event.
        if (ctx.fc.scopeOf(node) !== ctx.fc.binding.root) return;
        if (ctx.fc.ancestors(node).some((a) => a.type === "WithStatement")) return;
        const ancestors = c.objectChain(gml.owner).slice(1);
        if (ancestors.length > 0) {
          let collisionTargets: Set<string> | null = null;
          if (ev.type === "Collision") {
            if (!ev.collisionObject) return;
            collisionTargets = new Set(c.objectChain(ev.collisionObject));
          }
          for (const a of ancestors) {
            const res = project.objects.get(a);
            if (!res) return; // missing parent: don't guess
            const found = res.events.some(
              (e) =>
                e.typeNumber === ev.typeNumber &&
                (collisionTargets ? e.collisionObject !== null && collisionTargets.has(e.collisionObject) : e.number === ev.number),
            );
            if (found) return;
          }
        }
        ctx.report({ node, message: "Call to event_inherited() in object with no parent event." });
      },
    };
  },
});
