/**
 * A GameMaker project (.yyp) as a read-only model: resources, their GML
 * files, object inheritance, events, rooms and extensions.
 */

export type ResourceType =
  | "object"
  | "script"
  | "room"
  | "sprite"
  | "sound"
  | "path"
  | "font"
  | "timeline"
  | "tileset"
  | "sequence"
  | "animcurve"
  | "shader"
  | "extension"
  | "note"
  | "particlesystem"
  | "other";

/** GameMaker event types, by `eventType` number. */
export type EventType =
  | "Create"        // 0
  | "Destroy"       // 1
  | "Alarm"         // 2
  | "Step"          // 3  (num 0 step, 1 begin, 2 end)
  | "Collision"     // 4
  | "Keyboard"      // 5
  | "Mouse"         // 6
  | "Other"         // 7  (4 room start, 5 room end, 7 animation end, 10-25 user events, 60+ async ...)
  | "Draw"          // 8  (0 draw, 64 gui, 72 begin, 73 end, 74 gui begin, 75 gui end, 76 pre, 77 post, 65 resize)
  | "KeyPress"      // 9
  | "KeyRelease"    // 10
  | "Trigger"       // 11
  | "CleanUp"       // 12
  | "Gesture"       // 13
  | "PreCreate";    // 14

export interface EventInfo {
  type: EventType;
  /** Raw `eventType` number. */
  typeNumber: number;
  /** `eventNum`. */
  number: number;
  /** Collision events: the other object's name. */
  collisionObject: string | null;
  /** GML file name stem as written on disk, e.g. "Step_2", "Collision_obj_wall". */
  fileName: string;
  /** Human-readable, e.g. "End Step", "Draw GUI", "User Event 3", "Alarm 0". */
  displayName: string;
}

export type GmlFileKind = "script" | "event" | "room-creation" | "instance-creation";

export interface GmlFile {
  /** Absolute path, normalised with forward slashes. */
  path: string;
  /** Path relative to the project directory, forward slashes. */
  relativePath: string;
  kind: GmlFileKind;
  /** Owning resource name (script, object, or room). */
  owner: string;
  /** For events. */
  event?: EventInfo;
  /**
   * For events: whether the object's .yy lists this event. Files on disk
   * that are not listed are never run by GameMaker.
   */
  listed?: boolean;
  /** For instance creation code. */
  instance?: { room: string; name: string; object: string | null };
}

export interface Resource {
  name: string;
  type: ResourceType;
  /** Absolute path to the .yy file (forward slashes). */
  yyPath: string;
  /** Virtual Asset Browser folder, e.g. "Objects/Game/Core" (no "folders/" prefix or ".yy"). */
  folder: string | null;
  /** Tags from the .yy, if any. */
  tags: string[];
  /** Parsed .yy contents. */
  raw: Record<string, unknown>;
}

export interface ObjectProperty {
  /** Variable Definition name. */
  name: string;
  /** GameMaker varType: 0 real, 1 integer, 2 string, 3 boolean, 4 expression, 5 asset, 6 list, 7 colour. */
  varType: number;
  value: string;
}

export interface ObjectResource extends Resource {
  type: "object";
  parent: string | null;
  sprite: string | null;
  mask: string | null;
  persistent: boolean;
  visible: boolean;
  solid: boolean;
  /** Events listed in the .yy `eventList`. */
  events: EventInfo[];
  /** Event GML files present on disk (listed or not). */
  eventFiles: GmlFile[];
  /** Variable Definitions declared on this object. */
  properties: ObjectProperty[];
  /** Variable Definitions overridden from a parent: name -> value. */
  overriddenProperties: Array<{ name: string; value: string; definedOn: string | null }>;
}

export interface ScriptResource extends Resource {
  type: "script";
  file: GmlFile | null;
}

export interface RoomInstance {
  /** Instance name, e.g. "inst_34BB5552". */
  name: string;
  object: string | null;
  layer: string;
  creationCode: GmlFile | null;
  /** Variable Definition overrides on this instance. */
  properties: Array<{ name: string; value: string; definedOn: string | null }>;
}

export interface RoomResource extends Resource {
  type: "room";
  parentRoom: string | null;
  creationCode: GmlFile | null;
  instances: RoomInstance[];
  /** Instance creation order (names). */
  creationOrder: string[];
  layers: string[];
}

export interface ExtensionFunction {
  name: string;
  /** -1 for variable argument count. */
  argCount: number;
  /** Argument types: 1 = string, 2 = real (GameMaker's encoding). */
  args: number[];
  returnType: number;
  hidden: boolean;
  help: string;
}

export interface ExtensionResource extends Resource {
  type: "extension";
  functions: ExtensionFunction[];
  constants: Array<{ name: string; value: string; hidden: boolean }>;
}

export interface SequenceResource extends Resource {
  type: "sequence";
  /** Objects referenced by instance tracks. */
  objects: string[];
}

export interface IncludedFile {
  name: string;
  /** Path relative to the project, e.g. "datafiles/locale/en-ca.P40". */
  relativePath: string;
  /** Absolute path. */
  path: string;
}

export interface LoadDiagnostic {
  /** "error" when something could not be read; "warning" for inconsistencies. */
  severity: "error" | "warning";
  message: string;
  /** File the problem concerns (absolute). */
  file: string | null;
}

export interface Project {
  name: string;
  /** Absolute project directory (forward slashes). */
  dir: string;
  yypPath: string;
  /** `MetaData.IDEVersion`. */
  ideVersion: string | null;
  /** All resources by name. */
  resources: Map<string, Resource>;
  objects: Map<string, ObjectResource>;
  scripts: Map<string, ScriptResource>;
  rooms: Map<string, RoomResource>;
  extensions: Map<string, ExtensionResource>;
  sequences: Map<string, SequenceResource>;
  /** Every GML file of the project: scripts, events, room and instance creation code. */
  gmlFiles: GmlFile[];
  includedFiles: IncludedFile[];
  /** Configuration names (`configs` in the .yyp), including "Default". */
  configs: string[];
  diagnostics: LoadDiagnostic[];
}
