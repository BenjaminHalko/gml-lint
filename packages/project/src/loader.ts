import * as fs from "node:fs";
import * as path from "node:path";
import { eventFromFileName, makeEventInfo } from "./events.js";
import type {
  EventInfo,
  ExtensionFunction,
  ExtensionResource,
  GmlFile,
  LoadDiagnostic,
  ObjectProperty,
  ObjectResource,
  Project,
  Resource,
  ResourceType,
  RoomInstance,
  RoomResource,
  ScriptResource,
  SequenceResource,
} from "./types.js";
import {
  asArray,
  asBool,
  asNumber,
  asRecord,
  asString,
  asValueString,
  dirOf,
  isRecord,
  joinRel,
  normPath,
  refName,
  type Rec,
} from "./util.js";
import { readYY } from "./yy.js";

const RESOURCE_TYPES: Record<string, ResourceType> = {
  GMObject: "object",
  GMScript: "script",
  GMRoom: "room",
  GMSprite: "sprite",
  GMSound: "sound",
  GMPath: "path",
  GMFont: "font",
  GMTimeline: "timeline",
  GMTileSet: "tileset",
  GMSequence: "sequence",
  GMAnimationCurve: "animcurve",
  GMShader: "shader",
  GMExtension: "extension",
  GMNotes: "note",
  GMParticleSystem: "particlesystem",
};

/** Fallback when the .yy can't be read: infer from the top-level directory. */
const DIR_TYPES: Record<string, ResourceType> = {
  objects: "object",
  scripts: "script",
  rooms: "room",
  sprites: "sprite",
  sounds: "sound",
  paths: "path",
  fonts: "font",
  timelines: "timeline",
  tilesets: "tileset",
  sequences: "sequence",
  animcurves: "animcurve",
  shaders: "shader",
  extensions: "extension",
  notes: "note",
  particles: "particlesystem",
};

/** Asset types without GML whose .yy is parsed on first access. */
const LAZY_TYPES: ReadonlySet<ResourceType> = new Set<ResourceType>([
  "sprite",
  "sound",
  "path",
  "font",
  "tileset",
  "animcurve",
  "shader",
  "note",
  "particlesystem",
]);

/** Locates the .yyp for a path that is either a .yyp file or a directory containing exactly one. */
export function resolveYypPath(pathOrDir: string): string {
  const abs = path.resolve(pathOrDir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`GameMaker project not found: ${abs}`);
  }
  if (stat.isFile()) return normPath(abs);
  if (!stat.isDirectory()) throw new Error(`Not a file or directory: ${abs}`);
  const yyps = fs.readdirSync(abs).filter((f) => f.toLowerCase().endsWith(".yyp"));
  if (yyps.length === 0) throw new Error(`No .yyp file in directory: ${abs}`);
  if (yyps.length > 1) throw new Error(`Multiple .yyp files in directory ${abs}: ${yyps.join(", ")}`);
  return normPath(path.join(abs, yyps[0] as string));
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

class Loader {
  readonly dir: string;
  readonly diagnostics: LoadDiagnostic[] = [];
  readonly gmlFiles: GmlFile[] = [];

  constructor(dir: string) {
    this.dir = dir;
  }

  diag(severity: LoadDiagnostic["severity"], message: string, file: string | null): void {
    this.diagnostics.push({ severity, message, file });
  }

  rel(abs: string): string {
    return abs.startsWith(this.dir + "/") ? abs.slice(this.dir.length + 1) : path.posix.relative(this.dir, abs);
  }

  /** Lists file names in a directory; [] (with no diagnostic) if it doesn't exist. */
  listDir(dir: string): string[] {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  }

  gml(abs: string, kind: GmlFile["kind"], owner: string): GmlFile {
    return { path: abs, relativePath: this.rel(abs), kind, owner };
  }

  readYYFile(abs: string): Rec | null {
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch (e) {
      this.diag("error", `Cannot read resource file: ${(e as Error).message}`, abs);
      return null;
    }
    try {
      const v = readYY(text);
      if (!isRecord(v)) {
        this.diag("error", "Resource file is not a JSON object", abs);
        return null;
      }
      return v;
    } catch (e) {
      this.diag("error", `Cannot parse resource file: ${(e as Error).message}`, abs);
      return null;
    }
  }

  /**
   * A resource whose .yy is only read when `raw`, `folder` or `tags` is first
   * accessed. Used for asset types without GML (sprites, sounds, ...), which
   * are most of a project's files.
   */
  lazy(name: string, relYY: string, type: ResourceType): Resource {
    const yyPath = joinRel(this.dir, relYY);
    let loaded: Resource | null = null;
    const get = (): Resource => (loaded ??= this.base(name, relYY, this.readYYFile(yyPath)));
    const res = { name, type, yyPath } as Resource;
    for (const key of ["folder", "tags", "raw"] as const) {
      Object.defineProperty(res, key, { enumerable: true, configurable: false, get: () => get()[key] });
    }
    return res;
  }

  base(name: string, relYY: string, raw: Rec | null): Resource {
    const yyPath = joinRel(this.dir, relYY);
    const r = raw ?? {};
    const rt = asString(r["resourceType"]);
    const type = (rt !== null ? RESOURCE_TYPES[rt] : DIR_TYPES[relYY.split("/")[0] ?? ""]) ?? "other";
    let folder: string | null = null;
    const parentPath = asString(asRecord(r["parent"])["path"]);
    if (parentPath !== null && !parentPath.toLowerCase().endsWith(".yyp")) {
      folder = parentPath.replace(/^folders\//, "").replace(/\.yy$/, "");
      if (folder === "") folder = null;
    }
    const tags = asArray(r["tags"]).filter((t): t is string => typeof t === "string");
    return { name, type, yyPath, folder, tags, raw: r };
  }

  object(base: Resource, readOk: boolean): ObjectResource {
    const raw = base.raw;
    const events: EventInfo[] = [];
    for (const ev of asArray(raw["eventList"])) {
      const e = asRecord(ev);
      const info = makeEventInfo(asNumber(e["eventType"], -1), asNumber(e["eventNum"], 0), refName(e["collisionObjectId"]));
      if (info) events.push(info);
      else this.diag("warning", `Object ${base.name}: unknown event type ${String(e["eventType"])}`, base.yyPath);
    }
    const properties: ObjectProperty[] = asArray(raw["properties"]).map((p) => {
      const pr = asRecord(p);
      return {
        name: asString(pr["name"]) ?? "",
        varType: asNumber(pr["varType"], 0),
        value: asValueString(pr["value"]),
      };
    });
    const overriddenProperties = asArray(raw["overriddenProperties"]).map(overriddenProperty);

    // Event GML files on disk.
    const objDir = dirOf(base.yyPath);
    const listedByFile = new Map<string, EventInfo>();
    for (const ev of events) listedByFile.set(ev.fileName.toLowerCase(), ev);
    const eventFiles: GmlFile[] = [];
    const seen = new Set<string>();
    for (const f of this.listDir(objDir)) {
      if (!f.toLowerCase().endsWith(".gml")) continue;
      const stem = f.slice(0, -4);
      const abs = `${objDir}/${f}`;
      const parsed = eventFromFileName(stem);
      if (!parsed) {
        this.diag("warning", `Object ${base.name}: unrecognised GML file "${f}" (not an event file)`, abs);
        continue;
      }
      const key = stem.toLowerCase();
      const listedEv = listedByFile.get(key);
      const file = this.gml(abs, "event", base.name);
      file.event = listedEv ?? parsed;
      file.listed = listedEv !== undefined;
      if (listedEv) seen.add(key);
      else if (readOk)
        this.diag(
          "warning",
          `Object ${base.name}: event file "${f}" (${parsed.displayName}) is not listed in the object's eventList; GameMaker never runs it`,
          abs,
        );
      eventFiles.push(file);
    }
    for (const [key, ev] of listedByFile) {
      if (!seen.has(key))
        this.diag(
          "warning",
          `Object ${base.name}: listed event ${ev.displayName} has no GML file (${ev.fileName}.gml)`,
          `${objDir}/${ev.fileName}.gml`,
        );
    }
    eventFiles.sort(compareEventFiles);
    this.gmlFiles.push(...eventFiles);

    return {
      ...base,
      type: "object",
      parent: refName(raw["parentObjectId"]),
      sprite: refName(raw["spriteId"]),
      mask: refName(raw["spriteMaskId"]),
      persistent: asBool(raw["persistent"], false),
      visible: asBool(raw["visible"], true),
      solid: asBool(raw["solid"], false),
      events,
      eventFiles,
      properties,
      overriddenProperties,
    };
  }

  script(base: Resource): ScriptResource {
    const abs = `${dirOf(base.yyPath)}/${base.name}.gml`;
    let file: GmlFile | null = null;
    if (fs.existsSync(abs)) {
      file = this.gml(abs, "script", base.name);
      this.gmlFiles.push(file);
    } else {
      this.diag("warning", `Script ${base.name}: GML file is missing`, abs);
    }
    return { ...base, type: "script", file };
  }

  room(base: Resource): RoomResource {
    const raw = base.raw;
    const roomDir = dirOf(base.yyPath);
    let creationCode: GmlFile | null = null;
    const ccRel = asString(raw["creationCodeFile"]);
    if (ccRel) {
      const abs = joinRel(this.dir, ccRel);
      if (fs.existsSync(abs)) {
        creationCode = this.gml(abs, "room-creation", base.name);
        this.gmlFiles.push(creationCode);
      } else {
        this.diag("warning", `Room ${base.name}: creation code file is missing (treated as empty)`, abs);
      }
    }

    const onDisk = new Map<string, string>(); // lower-case file name -> actual name
    for (const f of this.listDir(roomDir)) onDisk.set(f.toLowerCase(), f);
    const used = new Set<string>();

    const layers: string[] = [];
    const instances: RoomInstance[] = [];
    const walk = (list: unknown): void => {
      for (const l of asArray(list)) {
        const layer = asRecord(l);
        const layerName = asString(layer["name"]) ?? "";
        layers.push(layerName);
        for (const inst of asArray(layer["instances"])) {
          const ir = asRecord(inst);
          const name = asString(ir["name"]) ?? "";
          const object = refName(ir["objectId"]);
          let cc: GmlFile | null = null;
          if (asBool(ir["hasCreationCode"], false)) {
            const fname = `InstanceCreationCode_${name}.gml`;
            const actual = onDisk.get(fname.toLowerCase());
            const abs = `${roomDir}/${actual ?? fname}`;
            if (actual !== undefined) {
              used.add(actual.toLowerCase());
              cc = this.gml(abs, "instance-creation", base.name);
              cc.instance = { room: base.name, name, object };
              this.gmlFiles.push(cc);
            } else {
              this.diag("warning", `Room ${base.name}: instance ${name} has creation code but the file is missing`, abs);
            }
          }
          instances.push({
            name,
            object,
            layer: layerName,
            creationCode: cc,
            properties: asArray(ir["properties"]).map(overriddenProperty),
          });
        }
        walk(layer["layers"]);
      }
    };
    walk(raw["layers"]);

    for (const [lower, actual] of onDisk) {
      if (lower.startsWith("instancecreationcode_") && lower.endsWith(".gml") && !used.has(lower)) {
        this.diag(
          "warning",
          `Room ${base.name}: "${actual}" does not belong to an instance with creation code; GameMaker never runs it`,
          `${roomDir}/${actual}`,
        );
      }
    }

    return {
      ...base,
      type: "room",
      parentRoom: refName(raw["parentRoom"]),
      creationCode,
      instances,
      creationOrder: asArray(raw["instanceCreationOrder"])
        .map(refName)
        .filter((n): n is string => n !== null),
      layers,
    };
  }

  extension(base: Resource): ExtensionResource {
    const functions: ExtensionFunction[] = [];
    const constants: ExtensionResource["constants"] = [];
    for (const f of asArray(base.raw["files"])) {
      const file = asRecord(f);
      for (const fn of asArray(file["functions"])) {
        const r = asRecord(fn);
        const name = asString(r["name"]);
        if (!name) continue;
        functions.push({
          name,
          argCount: asNumber(r["argCount"], -1),
          args: asArray(r["args"]).filter((a): a is number => typeof a === "number"),
          returnType: asNumber(r["returnType"], 2),
          hidden: asBool(r["hidden"], false),
          help: asString(r["help"]) ?? "",
        });
      }
      for (const c of asArray(file["constants"])) {
        const r = asRecord(c);
        const name = asString(r["name"]);
        if (!name) continue;
        constants.push({ name, value: asValueString(r["value"]), hidden: asBool(r["hidden"], false) });
      }
    }
    return { ...base, type: "extension", functions, constants };
  }

  sequence(base: Resource): SequenceResource {
    const found = new Set<string>();
    const scan = (v: unknown): void => {
      if (Array.isArray(v)) {
        for (const x of v) scan(x);
        return;
      }
      if (!isRecord(v)) return;
      const n = v["name"];
      const p = v["path"];
      if (typeof n === "string" && typeof p === "string" && p.startsWith("objects/")) found.add(n);
      for (const k in v) scan(v[k]);
    };
    scan(base.raw);
    return { ...base, type: "sequence", objects: [...found] };
  }
}

function overriddenProperty(p: unknown): { name: string; value: string; definedOn: string | null } {
  const pr = asRecord(p);
  return {
    name: refName(pr["propertyId"]) ?? asString(pr["name"]) ?? "",
    value: asValueString(pr["value"]),
    definedOn: refName(pr["objectId"]),
  };
}

function compareEventFiles(a: GmlFile, b: GmlFile): number {
  const ea = a.event;
  const eb = b.event;
  if (ea && eb) {
    if (ea.typeNumber !== eb.typeNumber) return ea.typeNumber - eb.typeNumber;
    if (ea.number !== eb.number) return ea.number - eb.number;
  }
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function flattenConfigs(node: unknown, out: string[]): void {
  const r = asRecord(node);
  const name = asString(r["name"]);
  if (name !== null) out.push(name);
  for (const c of asArray(r["children"])) flattenConfigs(c, out);
}

/**
 * Loads a GameMaker project. `pathOrDir` is a .yyp path or a directory
 * containing exactly one .yyp. Problems inside individual resources are
 * recorded in `diagnostics`; only an unreadable .yyp throws.
 */
export function loadProject(pathOrDir: string): Project {
  const yypPath = resolveYypPath(pathOrDir);
  const dir = dirOf(yypPath);
  let yypText: string;
  try {
    yypText = fs.readFileSync(yypPath, "utf8");
  } catch (e) {
    throw new Error(`Cannot read ${yypPath}: ${(e as Error).message}`);
  }
  let yypRaw: unknown;
  try {
    yypRaw = readYY(yypText);
  } catch (e) {
    throw new Error(`Cannot parse ${yypPath}: ${(e as Error).message}`);
  }
  if (!isRecord(yypRaw)) throw new Error(`Not a GameMaker project: ${yypPath}`);

  const L = new Loader(dir);
  const project: Project = {
    name: asString(yypRaw["%Name"]) ?? asString(yypRaw["name"]) ?? path.posix.basename(yypPath, ".yyp"),
    dir,
    yypPath,
    ideVersion: asString(asRecord(yypRaw["MetaData"])["IDEVersion"]),
    resources: new Map(),
    objects: new Map(),
    scripts: new Map(),
    rooms: new Map(),
    extensions: new Map(),
    sequences: new Map(),
    gmlFiles: L.gmlFiles,
    includedFiles: [],
    configs: [],
    diagnostics: L.diagnostics,
  };

  for (const entry of asArray(yypRaw["resources"])) {
    const id = asRecord(asRecord(entry)["id"]);
    const name = asString(id["name"]);
    const relYY = asString(id["path"]);
    if (!name || !relYY) {
      L.diag("warning", "Malformed resource entry in .yyp", yypPath);
      continue;
    }
    if (project.resources.has(name)) {
      L.diag("warning", `Duplicate resource name "${name}" in .yyp`, yypPath);
      continue;
    }
    const absYY = joinRel(dir, relYY);
    const dirType = DIR_TYPES[relYY.split("/")[0] ?? ""];
    if (dirType !== undefined && LAZY_TYPES.has(dirType)) {
      project.resources.set(name, L.lazy(name, relYY, dirType));
      continue;
    }
    const raw = L.readYYFile(absYY);
    const base = L.base(name, relYY, raw);
    let res: Resource;
    switch (base.type) {
      case "object": {
        const o = L.object(base, raw !== null);
        project.objects.set(name, o);
        res = o;
        break;
      }
      case "script": {
        const s = L.script(base);
        project.scripts.set(name, s);
        res = s;
        break;
      }
      case "room": {
        const r = L.room(base);
        project.rooms.set(name, r);
        res = r;
        break;
      }
      case "extension": {
        const x = L.extension(base);
        project.extensions.set(name, x);
        res = x;
        break;
      }
      case "sequence": {
        const s = L.sequence(base);
        project.sequences.set(name, s);
        res = s;
        break;
      }
      default:
        res = base;
    }
    project.resources.set(name, res);
  }

  // Unknown parents are worth flagging: inheritance silently breaks.
  for (const o of project.objects.values()) {
    if (o.parent !== null && !project.objects.has(o.parent)) {
      L.diag("warning", `Object ${o.name}: parent object "${o.parent}" is not in the project`, o.yyPath);
    }
  }

  for (const f of asArray(yypRaw["IncludedFiles"])) {
    const r = asRecord(f);
    const name = asString(r["name"]);
    if (!name) continue;
    const filePath = (asString(r["filePath"]) ?? "datafiles").replace(/\\/g, "/").replace(/\/+$/, "");
    const relativePath = filePath === "" ? name : `${filePath}/${name}`;
    project.includedFiles.push({ name, relativePath, path: joinRel(dir, relativePath) });
  }

  flattenConfigs(yypRaw["configs"], project.configs);
  if (project.configs.length === 0) project.configs.push("Default");

  return project;
}

/** Reads a GML file as UTF-8, stripping a BOM. */
export function readGml(file: GmlFile | string): string {
  const p = typeof file === "string" ? file : file.path;
  return stripBom(fs.readFileSync(p, "utf8"));
}
