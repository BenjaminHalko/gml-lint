import type { EventInfo, EventType } from "./types.js";

/** EventType names indexed by `eventType` number. */
export const EVENT_TYPES: readonly EventType[] = [
  "Create",
  "Destroy",
  "Alarm",
  "Step",
  "Collision",
  "Keyboard",
  "Mouse",
  "Other",
  "Draw",
  "KeyPress",
  "KeyRelease",
  "Trigger",
  "CleanUp",
  "Gesture",
  "PreCreate",
];

const TYPE_NUMBERS: ReadonlyMap<string, number> = new Map(EVENT_TYPES.map((t, i) => [t, i]));

const STEP_NAMES: Record<number, string> = { 0: "Step", 1: "Begin Step", 2: "End Step" };

const DRAW_NAMES: Record<number, string> = {
  0: "Draw",
  64: "Draw GUI",
  65: "Window Resize",
  72: "Draw Begin",
  73: "Draw End",
  74: "Draw GUI Begin",
  75: "Draw GUI End",
  76: "Pre-Draw",
  77: "Post-Draw",
};

const OTHER_NAMES: Record<number, string> = {
  0: "Outside Room",
  1: "Intersect Boundary",
  2: "Game Start",
  3: "Game End",
  4: "Room Start",
  5: "Room End",
  7: "Animation End",
  8: "End of Path",
  58: "Animation Update",
  59: "Animation Event",
  60: "Async - Image Loaded",
  62: "Async - HTTP",
  63: "Async - Dialog",
  66: "Async - In-App Purchase",
  67: "Async - Cloud",
  68: "Async - Networking",
  69: "Async - Steam",
  70: "Async - Social",
  71: "Async - Push Notification",
  72: "Async - Save/Load",
  73: "Async - Audio Recording",
  74: "Async - Audio Playback",
  75: "Async - System",
  76: "Broadcast Message",
};

/** Human-readable event name, e.g. "End Step", "Draw GUI", "User Event 3", "Alarm 0". */
export function eventDisplayName(typeNumber: number, number: number, collisionObject?: string | null): string {
  const type = EVENT_TYPES[typeNumber];
  switch (type) {
    case "Create":
    case "Destroy":
      return number === 0 ? type : `${type} ${number}`;
    case "CleanUp":
      return number === 0 ? "Clean Up" : `Clean Up ${number}`;
    case "PreCreate":
      return number === 0 ? "Pre-Create" : `Pre-Create ${number}`;
    case "Step":
      return STEP_NAMES[number] ?? `Step ${number}`;
    case "Draw":
      return DRAW_NAMES[number] ?? `Draw ${number}`;
    case "Collision":
      return `Collision ${collisionObject ?? number}`;
    case "Other": {
      const known = OTHER_NAMES[number];
      if (known !== undefined) return known;
      if (number >= 10 && number <= 25) return `User Event ${number - 10}`;
      if (number >= 40 && number <= 47) return `Outside View ${number - 40}`;
      if (number >= 50 && number <= 57) return `Intersect View ${number - 50} Boundary`;
      return `Other ${number}`;
    }
    case undefined:
      return `Event ${typeNumber} ${number}`;
    default:
      return `${type} ${number}`;
  }
}

/**
 * GML file name stem for an event, e.g. "Step_2", "Collision_obj_wall".
 * Collision events use the other object's name when given.
 */
export function eventFileName(typeNumber: number, number: number, collisionObject?: string | null): string {
  const type = EVENT_TYPES[typeNumber] ?? `Event${typeNumber}`;
  if (type === "Collision" && collisionObject) return `Collision_${collisionObject}`;
  return `${type}_${number}`;
}

/** Builds an EventInfo, or null for an unknown `eventType`. */
export function makeEventInfo(typeNumber: number, number: number, collisionObject: string | null = null): EventInfo | null {
  const type = EVENT_TYPES[typeNumber];
  if (type === undefined) return null;
  const coll = type === "Collision" ? collisionObject : null;
  return {
    type,
    typeNumber,
    number: type === "Collision" ? 0 : number,
    collisionObject: coll,
    fileName: eventFileName(typeNumber, number, coll),
    displayName: eventDisplayName(typeNumber, number, coll),
  };
}

const INT_RE = /^\d+$/;

/** Parses an event file name stem ("Step_2", "Collision_obj_wall"; ".gml" optional). */
export function eventFromFileName(stem: string): EventInfo | null {
  const base = stem.toLowerCase().endsWith(".gml") ? stem.slice(0, -4) : stem;
  const us = base.indexOf("_");
  if (us <= 0 || us === base.length - 1) return null;
  const typeName = base.slice(0, us);
  const suffix = base.slice(us + 1);
  const typeNumber = TYPE_NUMBERS.get(typeName);
  if (typeNumber === undefined) return null;
  if (typeName === "Collision") {
    const info = makeEventInfo(typeNumber, 0, suffix);
    if (info) info.fileName = base;
    return info;
  }
  if (!INT_RE.test(suffix)) return null;
  const info = makeEventInfo(typeNumber, Number(suffix));
  if (info) info.fileName = base;
  return info;
}
