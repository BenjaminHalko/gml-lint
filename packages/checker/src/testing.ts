/**
 * Test utilities: in-memory projects checked against the bundled GmlSpec.xml.
 *
 *   const diags = diagnose(GM1013, {
 *     "objects/obj_a/Create_0.gml": "hp = 10;",
 *     "objects/obj_a/Step_0.gml": "hp -= dmg;",
 *   });
 */

import type { EventInfo, GmlFile, ObjectResource, Project, Resource, ResourceType, RoomResource, ScriptResource } from "@gml-lint/project";
import { eventFromFileName } from "@gml-lint/project";
import type { Check, Diagnostic } from "./checks/api.js";
import type { GmlintConfig } from "./checks/config.js";
import { runChecks } from "./checks/runner.js";
import { Program } from "./program.js";
import { createEmptySpec, loadSpec, parseSpecXml, type GmlSpec } from "./spec/index.js";

/** The bundled GmlSpec.xml, optionally extended with more `<GameMakerLanguageSpec>` XML. */
export function testSpec(extraXml?: string): GmlSpec {
  const base = loadSpec();
  if (!extraXml) return base;
  const spec = createEmptySpec();
  for (const key of ["functions", "variables", "constants", "structures", "enumerations"] as const) {
    for (const [name, entry] of base[key]) (spec[key] as Map<string, unknown>).set(name, entry);
  }
  return parseSpecXml(extraXml, "test-extra", spec);
}

export interface TestProject {
  /** Project-relative path -> GML. Objects/scripts/rooms are inferred from paths. */
  files: Record<string, string>;
  /** Extra object info (parents, Variable Definitions); objects are also created from event paths. */
  objects?: Record<string, { parent?: string; properties?: string[]; folder?: string }>;
  /** Room instances: name -> { room, object }. */
  instances?: Record<string, { room: string; object: string }>;
  /** Other assets: name -> type. */
  assets?: Record<string, ResourceType>;
  /** Asset Browser folders for scripts: name -> folder. */
  folders?: Record<string, string>;
}

const ROOT = "/test-project";

function isTestProject(x: TestProject | Record<string, string>): x is TestProject {
  return typeof (x as TestProject).files === "object";
}

/** Builds an in-memory Project + Program. */
export function createTestProgram(
  input: TestProject | Record<string, string>,
  options: { spec?: GmlSpec | null } = {},
): Program {
  const tp: TestProject = isTestProject(input) ? input : { files: input };
  const project = buildProject(tp);
  const texts = new Map<string, string>();
  for (const [rel, text] of Object.entries(tp.files)) texts.set(`${ROOT}/${rel}`, text);
  return new Program({
    project,
    spec: options.spec === undefined ? testSpec() : options.spec,
    readFile: (p) => texts.get(p),
  });
}

function baseResource(name: string, type: ResourceType, yyPath: string, folder: string | null): Resource {
  return { name, type, yyPath: `${ROOT}/${yyPath}`, folder, tags: [], raw: {} };
}

function buildProject(tp: TestProject): Project {
  const resources = new Map<string, Resource>();
  const objects = new Map<string, ObjectResource>();
  const scripts = new Map<string, ScriptResource>();
  const rooms = new Map<string, RoomResource>();
  const gmlFiles: GmlFile[] = [];

  const ensureObject = (name: string): ObjectResource => {
    let o = objects.get(name);
    if (!o) {
      const info = tp.objects?.[name];
      o = {
        ...baseResource(name, "object", `objects/${name}/${name}.yy`, info?.folder ?? "Objects"),
        type: "object",
        parent: info?.parent ?? null,
        sprite: null,
        mask: null,
        persistent: false,
        visible: true,
        solid: false,
        events: [],
        eventFiles: [],
        properties: (info?.properties ?? []).map((p) => ({ name: p, varType: 0, value: "0" })),
        overriddenProperties: [],
      };
      objects.set(name, o);
      resources.set(name, o);
    }
    return o;
  };
  const ensureRoom = (name: string): RoomResource => {
    let r = rooms.get(name);
    if (!r) {
      r = {
        ...baseResource(name, "room", `rooms/${name}/${name}.yy`, "Rooms"),
        type: "room",
        parentRoom: null,
        creationCode: null,
        instances: [],
        creationOrder: [],
        layers: ["Instances"],
      };
      rooms.set(name, r);
      resources.set(name, r);
    }
    return r;
  };

  for (const name of Object.keys(tp.objects ?? {})) ensureObject(name);
  for (const [name, inst] of Object.entries(tp.instances ?? {})) {
    const room = ensureRoom(inst.room);
    room.instances.push({ name, object: inst.object, layer: "Instances", creationCode: null, properties: [] });
    room.creationOrder.push(name);
  }

  for (const rel of Object.keys(tp.files)) {
    const path = `${ROOT}/${rel}`;
    const parts = rel.split("/");
    let m: RegExpExecArray | null;
    if (parts[0] === "objects" && parts.length === 3) {
      const obj = ensureObject(parts[1]!);
      const event: EventInfo | null = eventFromFileName(parts[2]!.replace(/\.gml$/, ""));
      const file: GmlFile = { path, relativePath: rel, kind: "event", owner: obj.name, listed: true, ...(event ? { event } : {}) };
      if (event) obj.events.push(event);
      obj.eventFiles.push(file);
      gmlFiles.push(file);
    } else if (parts[0] === "scripts" && parts.length === 3) {
      const name = parts[1]!;
      const file: GmlFile = { path, relativePath: rel, kind: "script", owner: name };
      const s: ScriptResource = { ...baseResource(name, "script", `scripts/${name}/${name}.yy`, tp.folders?.[name] ?? "Scripts"), type: "script", file };
      scripts.set(name, s);
      resources.set(name, s);
      gmlFiles.push(file);
    } else if (parts[0] === "rooms" && parts.length === 3 && (m = /^InstanceCreationCode_(.+)\.gml$/.exec(parts[2]!))) {
      const room = ensureRoom(parts[1]!);
      const instName = m[1]!;
      let inst = room.instances.find((i) => i.name === instName);
      if (!inst) {
        inst = { name: instName, object: tp.instances?.[instName]?.object ?? null, layer: "Instances", creationCode: null, properties: [] };
        room.instances.push(inst);
      }
      const file: GmlFile = { path, relativePath: rel, kind: "instance-creation", owner: room.name, instance: { room: room.name, name: instName, object: inst.object } };
      inst.creationCode = file;
      gmlFiles.push(file);
    } else if (parts[0] === "rooms" && parts.length === 3 && parts[2] === "RoomCreationCode.gml") {
      const room = ensureRoom(parts[1]!);
      const file: GmlFile = { path, relativePath: rel, kind: "room-creation", owner: room.name };
      room.creationCode = file;
      gmlFiles.push(file);
    } else {
      throw new Error(`createTestProgram: unrecognised path ${rel}`);
    }
  }

  for (const [name, type] of Object.entries(tp.assets ?? {})) {
    if (type === "object") ensureObject(name);
    else if (type === "room") ensureRoom(name);
    else resources.set(name, baseResource(name, type, `${type}s/${name}/${name}.yy`, null));
  }

  return {
    name: "TestProject",
    dir: ROOT,
    yypPath: `${ROOT}/TestProject.yyp`,
    ideVersion: "test",
    resources,
    objects,
    scripts,
    rooms,
    extensions: new Map(),
    sequences: new Map(),
    gmlFiles,
    includedFiles: [],
    configs: ["Default"],
    diagnostics: [],
  };
}

export interface SimpleDiagnostic {
  code: string;
  message: string;
  /** Project-relative path. */
  file: string;
  line: number;
  column: number;
  /** Source text of the reported range. */
  text: string;
}

/** Runs checks (all enabled, at their default severity) and returns simplified diagnostics. */
export function diagnose(
  checks: Check | readonly Check[],
  input: TestProject | Record<string, string>,
  options: { spec?: GmlSpec | null; config?: GmlintConfig } = {},
): SimpleDiagnostic[] {
  const program = createTestProgram(input, options.spec === undefined ? {} : { spec: options.spec });
  const list = Array.isArray(checks) ? checks : [checks as Check];
  const rules: GmlintConfig["rules"] = {};
  for (const c of list) rules[c.meta.code] = c.meta.defaultSeverity;
  const config: GmlintConfig = { preset: "syntax", ...options.config, rules: { ...rules, ...options.config?.rules } };
  const result = runChecks(program, { checks: list, config });
  return result.diagnostics.map((d) => simplify(program, d));
}

function simplify(program: Program, d: Diagnostic): SimpleDiagnostic {
  const file = program.getSourceFile(d.file)!;
  return {
    code: d.code,
    message: d.message,
    file: file.gml?.relativePath ?? d.file,
    line: d.loc.start.line,
    column: d.loc.start.column + 1,
    text: file.text.slice(d.range[0], d.range[1]),
  };
}
