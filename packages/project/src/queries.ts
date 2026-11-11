import type { EventInfo, GmlFile, ObjectResource, Project } from "./types.js";

const childIndex = new WeakMap<Project, Map<string, ObjectResource[]>>();

function children(project: Project): Map<string, ObjectResource[]> {
  let idx = childIndex.get(project);
  if (!idx) {
    idx = new Map();
    for (const o of project.objects.values()) {
      if (o.parent === null) continue;
      let list = idx.get(o.parent);
      if (!list) idx.set(o.parent, (list = []));
      list.push(o);
    }
    childIndex.set(project, idx);
  }
  return idx;
}

/** Ancestors of an object, nearest parent first. Stops at unknown parents and cycles. */
export function objectAncestors(project: Project, objectName: string): ObjectResource[] {
  const out: ObjectResource[] = [];
  const seen = new Set<string>([objectName]);
  let cur = project.objects.get(objectName)?.parent ?? null;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const o = project.objects.get(cur);
    if (!o) break;
    out.push(o);
    cur = o.parent;
  }
  return out;
}

/** Objects whose direct parent is `objectName`. */
export function objectChildren(project: Project, objectName: string): ObjectResource[] {
  return children(project).get(objectName)?.slice() ?? [];
}

/** All descendants of an object (breadth-first), guarding against cycles. */
export function objectDescendants(project: Project, objectName: string): ObjectResource[] {
  const idx = children(project);
  const out: ObjectResource[] = [];
  const seen = new Set<string>([objectName]);
  const queue = [objectName];
  for (let i = 0; i < queue.length; i++) {
    for (const c of idx.get(queue[i] as string) ?? []) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      out.push(c);
      queue.push(c.name);
    }
  }
  return out;
}

function matches(ev: EventInfo, typeNumber: number, number: number, collisionObject?: string | null): boolean {
  if (ev.typeNumber !== typeNumber) return false;
  if (ev.type === "Collision") return collisionObject == null || ev.collisionObject === collisionObject;
  return ev.number === number;
}

/**
 * The GML file of an object's own event (listed or not; check `listed`).
 * Listed files win over unlisted ones. For collisions, `number` is ignored
 * and `collisionObject` selects the other object (any if omitted).
 */
export function findEventFile(
  project: Project,
  objectName: string,
  typeNumber: number,
  number: number,
  collisionObject?: string | null,
): GmlFile | null {
  const o = project.objects.get(objectName);
  if (!o) return null;
  let fallback: GmlFile | null = null;
  for (const f of o.eventFiles) {
    if (!f.event || !matches(f.event, typeNumber, number, collisionObject)) continue;
    if (f.listed) return f;
    fallback ??= f;
  }
  return fallback;
}

export interface ResolvedEvent {
  /** The object (the queried one or an ancestor) that defines the event. */
  object: ObjectResource;
  event: EventInfo;
  /** Its GML file, or null if listed but missing on disk. */
  file: GmlFile | null;
}

/**
 * Nearest object in the chain (itself first, then ancestors) whose eventList
 * contains the event, i.e. the code GameMaker runs for it. Null if none.
 */
export function resolveInheritedEvent(
  project: Project,
  objectName: string,
  typeNumber: number,
  number: number,
  collisionObject?: string | null,
): ResolvedEvent | null {
  const self = project.objects.get(objectName);
  if (!self) return null;
  for (const o of [self, ...objectAncestors(project, objectName)]) {
    const ev = o.events.find((e) => matches(e, typeNumber, number, collisionObject));
    if (!ev) continue;
    const file =
      o.eventFiles.find((f) => f.listed && f.event && f.event.fileName.toLowerCase() === ev.fileName.toLowerCase()) ?? null;
    return { object: o, event: ev, file };
  }
  return null;
}
