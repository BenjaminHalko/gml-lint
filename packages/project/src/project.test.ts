import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  eventFileName,
  eventFromFileName,
  findEventFile,
  loadProject,
  objectAncestors,
  objectChildren,
  objectDescendants,
  readGml,
  readYY,
  resolveInheritedEvent,
  type Project,
} from "./index.js";

describe("readYY", () => {
  it("strips trailing commas in nested objects and arrays", () => {
    const text = `{"a":1,"b":[1,2,[3,4,],{"c":{"d":[],},},],"e":{"f":null,},}`;
    expect(readYY(text)).toEqual({ a: 1, b: [1, 2, [3, 4], { c: { d: [] } }], e: { f: null } });
  });

  it("handles trailing commas followed by whitespace/newlines", () => {
    expect(readYY(`{\r\n  "a":[1,\r\n  ],\r\n  "b":2,\n\t}\n`)).toEqual({ a: [1], b: 2 });
  });

  it("leaves strings with commas, brackets and escaped quotes alone", () => {
    const text = String.raw`{"s":",}","t":"a,]","u":"q\",}","v":"back\\","w":",",}`;
    expect(readYY(text)).toEqual({ s: ",}", t: "a,]", u: 'q",}', v: "back\\", w: "," });
  });

  it("strips a BOM and accepts $-keys", () => {
    expect(readYY(`\uFEFF{"$GMObject":"","%Name":"x",}`)).toEqual({ $GMObject: "", "%Name": "x" });
  });

  it("throws on invalid JSON", () => {
    expect(() => readYY(`{"a":}`)).toThrow();
  });
});

describe("event file names", () => {
  const cases: Array<[string, string, number, number, string | null, string]> = [
    ["Create_0", "Create", 0, 0, null, "Create"],
    ["Destroy_0", "Destroy", 1, 0, null, "Destroy"],
    ["Alarm_3", "Alarm", 2, 3, null, "Alarm 3"],
    ["Step_0", "Step", 3, 0, null, "Step"],
    ["Step_1", "Step", 3, 1, null, "Begin Step"],
    ["Step_2", "Step", 3, 2, null, "End Step"],
    ["Collision_obj_wall", "Collision", 4, 0, "obj_wall", "Collision obj_wall"],
    ["Collision_6f1b3c3a-1111-2222-3333-444455556666", "Collision", 4, 0, "6f1b3c3a-1111-2222-3333-444455556666", "Collision 6f1b3c3a-1111-2222-3333-444455556666"],
    ["Keyboard_37", "Keyboard", 5, 37, null, "Keyboard 37"],
    ["Mouse_4", "Mouse", 6, 4, null, "Mouse 4"],
    ["Other_4", "Other", 7, 4, null, "Room Start"],
    ["Other_7", "Other", 7, 7, null, "Animation End"],
    ["Other_10", "Other", 7, 10, null, "User Event 0"],
    ["Other_25", "Other", 7, 25, null, "User Event 15"],
    ["Other_41", "Other", 7, 41, null, "Outside View 1"],
    ["Other_52", "Other", 7, 52, null, "Intersect View 2 Boundary"],
    ["Other_62", "Other", 7, 62, null, "Async - HTTP"],
    ["Other_72", "Other", 7, 72, null, "Async - Save/Load"],
    ["Other_76", "Other", 7, 76, null, "Broadcast Message"],
    ["Draw_0", "Draw", 8, 0, null, "Draw"],
    ["Draw_64", "Draw", 8, 64, null, "Draw GUI"],
    ["Draw_65", "Draw", 8, 65, null, "Window Resize"],
    ["Draw_72", "Draw", 8, 72, null, "Draw Begin"],
    ["Draw_73", "Draw", 8, 73, null, "Draw End"],
    ["Draw_74", "Draw", 8, 74, null, "Draw GUI Begin"],
    ["Draw_75", "Draw", 8, 75, null, "Draw GUI End"],
    ["Draw_76", "Draw", 8, 76, null, "Pre-Draw"],
    ["Draw_77", "Draw", 8, 77, null, "Post-Draw"],
    ["KeyPress_32", "KeyPress", 9, 32, null, "KeyPress 32"],
    ["KeyRelease_13", "KeyRelease", 10, 13, null, "KeyRelease 13"],
    ["Trigger_0", "Trigger", 11, 0, null, "Trigger 0"],
    ["CleanUp_0", "CleanUp", 12, 0, null, "Clean Up"],
    ["Gesture_5", "Gesture", 13, 5, null, "Gesture 5"],
    ["PreCreate_0", "PreCreate", 14, 0, null, "Pre-Create"],
  ];

  it.each(cases)("%s", (stem, type, typeNumber, number, coll, display) => {
    const e = eventFromFileName(stem);
    expect(e).toEqual({ type, typeNumber, number, collisionObject: coll, fileName: stem, displayName: display });
    expect(eventFileName(typeNumber, number, coll)).toBe(stem);
    expect(eventFromFileName(`${stem}.gml`)?.fileName).toBe(stem);
  });

  it("rejects non-event names", () => {
    for (const s of ["obj_player", "Create", "Create_", "Step_x", "Foo_0", "_0", "RoomCreationCode"]) {
      expect(eventFromFileName(s)).toBeNull();
    }
  });
});

describe("synthetic project", () => {
  let tmp: string;
  let project: Project;

  const write = (rel: string, content: string): void => {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const ev = (type: number, num: number, coll: string | null = null): string =>
    `{"$GMEvent":"v1","%Name":"","collisionObjectId":${coll ? `{"name":"${coll}","path":"objects/${coll}/${coll}.yy",}` : "null"},"eventNum":${num},"eventType":${type},"isDnD":false,"name":"","resourceType":"GMEvent","resourceVersion":"2.0",},`;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gml-project-"));
    write(
      "Test.yyp",
      `\uFEFF{
  "$GMProject":"v1",
  "%Name":"Test",
  "configs":{"children":[{"children":[{"children":[],"name":"Sub",},],"name":"Release",},],"name":"Default",},
  "Folders":[],
  "IncludedFiles":[
    {"$GMIncludedFile":"","%Name":"en.txt","CopyToMask":-1,"filePath":"datafiles/locale","name":"en.txt","resourceType":"GMIncludedFile","resourceVersion":"2.0",},
  ],
  "MetaData":{"IDEVersion":"2026.0.0.1",},
  "name":"Test",
  "resources":[
    {"id":{"name":"obj_parent","path":"objects/obj_parent/obj_parent.yy",},},
    {"id":{"name":"obj_child","path":"objects/obj_child/obj_child.yy",},},
    {"id":{"name":"obj_grandchild","path":"objects/obj_grandchild/obj_grandchild.yy",},},
    {"id":{"name":"scr_util","path":"scripts/scr_util/scr_util.yy",},},
    {"id":{"name":"rm_test","path":"rooms/rm_test/rm_test.yy",},},
    {"id":{"name":"obj_broken","path":"objects/obj_broken/obj_broken.yy",},},
    {"id":{"name":"spr_p","path":"sprites/spr_p/spr_p.yy",},},
  ],
}`,
    );
    write(
      "objects/obj_parent/obj_parent.yy",
      `{"$GMObject":"","%Name":"obj_parent","eventList":[${ev(0, 0)}${ev(3, 0)}${ev(8, 64)}],"name":"obj_parent",
"overriddenProperties":[],"parent":{"name":"Core","path":"folders/Objects/Game/Core.yy",},"parentObjectId":null,"persistent":true,
"properties":[{"$GMObjectProperty":"v2","%Name":"hp","name":"hp","resourceType":"GMObjectProperty","value":"10","varType":1,},],
"resourceType":"GMObject","resourceVersion":"2.0","solid":false,"spriteId":{"name":"spr_p","path":"sprites/spr_p/spr_p.yy",},"spriteMaskId":null,"tags":["core",],"visible":true,}`,
    );
    write("objects/obj_parent/Create_0.gml", "hp = 10;\n");
    write("objects/obj_parent/Step_0.gml", "x += 1;\n");
    write("objects/obj_parent/Draw_64.gml", "draw_self();\n");
    write(
      "objects/obj_child/obj_child.yy",
      `{"$GMObject":"","%Name":"obj_child","eventList":[${ev(0, 0)}${ev(4, 0, "obj_parent")}${ev(7, 10)}${ev(2, 1)}],"name":"obj_child",
"overriddenProperties":[{"$GMOverriddenProperty":"v1","%Name":"","name":"","objectId":{"name":"obj_parent","path":"objects/obj_parent/obj_parent.yy",},"propertyId":{"name":"hp","path":"objects/obj_parent/obj_parent.yy",},"resourceType":"GMOverriddenProperty","resourceVersion":"2.0","value":"20",},],
"parent":{"name":"Test","path":"Test.yyp",},"parentObjectId":{"name":"obj_parent","path":"objects/obj_parent/obj_parent.yy",},"persistent":false,"properties":[],
"resourceType":"GMObject","resourceVersion":"2.0","solid":true,"spriteId":null,"spriteMaskId":null,"visible":false,}`,
    );
    write("objects/obj_child/Create_0.gml", "\uFEFFevent_inherited();\nhp = 20;\n");
    write("objects/obj_child/Collision_obj_parent.gml", "instance_destroy();\n");
    write("objects/obj_child/Other_10.gml", "// user event 0\n");
    // Alarm_1 listed but missing; Step_2 present but unlisted.
    write("objects/obj_child/Step_2.gml", "// never runs\n");
    write(
      "objects/obj_grandchild/obj_grandchild.yy",
      `{"$GMObject":"","%Name":"obj_grandchild","eventList":[],"name":"obj_grandchild","parentObjectId":{"name":"obj_child","path":"objects/obj_child/obj_child.yy",},"resourceType":"GMObject","resourceVersion":"2.0",}`,
    );
    write("objects/obj_broken/obj_broken.yy", `{"$GMObject":"","eventList":[`);
    write(
      "scripts/scr_util/scr_util.yy",
      `{"$GMScript":"v1","%Name":"scr_util","isDnD":false,"name":"scr_util","parent":{"name":"Scripts","path":"folders/Scripts.yy",},"resourceType":"GMScript","resourceVersion":"2.0",}`,
    );
    write("scripts/scr_util/scr_util.gml", "function util() {}\n");
    write(
      "sprites/spr_p/spr_p.yy",
      `{"$GMSprite":"v2","%Name":"spr_p","name":"spr_p","parent":{"name":"Sprites","path":"folders/Sprites.yy",},"resourceType":"GMSprite","tags":["a","b",],"width":16,}`,
    );
    write(
      "rooms/rm_test/rm_test.yy",
      `{"$GMRoom":"v1","%Name":"rm_test","creationCodeFile":"rooms/rm_test/RoomCreationCode.gml","instanceCreationOrder":[{"name":"inst_A","path":"rooms/rm_test/rm_test.yy",},{"name":"inst_B","path":"rooms/rm_test/rm_test.yy",},],
"layers":[
  {"$GMRInstanceLayer":"","%Name":"Instances","instances":[
    {"$GMRInstance":"v4","%Name":"inst_A","hasCreationCode":true,"name":"inst_A","objectId":{"name":"obj_child","path":"objects/obj_child/obj_child.yy",},"properties":[{"$GMOverriddenProperty":"v1","%Name":"","name":"","objectId":{"name":"obj_parent","path":"objects/obj_parent/obj_parent.yy",},"propertyId":{"name":"hp","path":"objects/obj_parent/obj_parent.yy",},"value":"5",},],"resourceType":"GMRInstance",},
  ],"layers":[
    {"$GMRInstanceLayer":"","%Name":"Nested","instances":[
      {"$GMRInstance":"v4","%Name":"inst_B","hasCreationCode":false,"name":"inst_B","objectId":{"name":"obj_parent","path":"objects/obj_parent/obj_parent.yy",},"properties":[],"resourceType":"GMRInstance",},
    ],"layers":[],"name":"Nested","resourceType":"GMRInstanceLayer",},
  ],"name":"Instances","resourceType":"GMRInstanceLayer",},
  {"$GMRLayer":"","%Name":"Background","layers":[],"name":"Background","resourceType":"GMRBackgroundLayer",},
],"name":"rm_test","parentRoom":null,"resourceType":"GMRoom","resourceVersion":"2.0",}`,
    );
    write("rooms/rm_test/RoomCreationCode.gml", "show_debug_message(1);\n");
    write("rooms/rm_test/InstanceCreationCode_inst_A.gml", "hp = 1;\n");
    write("rooms/rm_test/InstanceCreationCode_inst_Gone.gml", "// orphan\n");
    // Prefab-style GML outside the resources: must be ignored.
    write("prefabs/thing/thing.gml", "// ignored\n");
    project = loadProject(tmp);
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reads project metadata", () => {
    const dir = path.resolve(tmp).replace(/\\/g, "/");
    expect(project.name).toBe("Test");
    expect(project.dir).toBe(dir);
    expect(project.yypPath).toBe(`${dir}/Test.yyp`);
    expect(project.ideVersion).toBe("2026.0.0.1");
    expect(project.configs).toEqual(["Default", "Release", "Sub"]);
    expect(project.includedFiles).toEqual([
      { name: "en.txt", relativePath: "datafiles/locale/en.txt", path: `${dir}/datafiles/locale/en.txt` },
    ]);
    expect(loadProject(path.join(tmp, "Test.yyp")).objects.size).toBe(project.objects.size);
  });

  it("models objects", () => {
    const p = project.objects.get("obj_parent")!;
    expect(p.folder).toBe("Objects/Game/Core");
    expect(p.tags).toEqual(["core"]);
    expect(p.sprite).toBe("spr_p");
    expect(p.persistent).toBe(true);
    expect(p.properties).toEqual([{ name: "hp", varType: 1, value: "10" }]);
    expect(p.events.map((e) => e.displayName)).toEqual(["Create", "Step", "Draw GUI"]);

    const c = project.objects.get("obj_child")!;
    expect(c.folder).toBeNull();
    expect(c.parent).toBe("obj_parent");
    expect(c.solid).toBe(true);
    expect(c.visible).toBe(false);
    expect(c.overriddenProperties).toEqual([{ name: "hp", value: "20", definedOn: "obj_parent" }]);
    expect(c.events.map((e) => e.fileName)).toEqual(["Create_0", "Collision_obj_parent", "Other_10", "Alarm_1"]);
    expect(c.eventFiles.map((f) => [f.relativePath, f.listed])).toEqual([
      ["objects/obj_child/Create_0.gml", true],
      ["objects/obj_child/Step_2.gml", false],
      ["objects/obj_child/Collision_obj_parent.gml", true],
      ["objects/obj_child/Other_10.gml", true],
    ]);
    const coll = c.eventFiles.find((f) => f.event?.type === "Collision")!;
    expect(coll.event?.collisionObject).toBe("obj_parent");
    expect(coll.kind).toBe("event");
    expect(coll.owner).toBe("obj_child");
    expect(readGml(c.eventFiles[0]!)).toBe("event_inherited();\nhp = 20;\n");
  });

  it("loads asset resources lazily", () => {
    const s = project.resources.get("spr_p")!;
    expect(s.type).toBe("sprite");
    expect(s.yyPath.endsWith("/sprites/spr_p/spr_p.yy")).toBe(true);
    expect(s.folder).toBe("Sprites");
    expect(s.tags).toEqual(["a", "b"]);
    expect(s.raw["width"]).toBe(16);
  });

  it("models scripts and rooms", () => {
    const s = project.scripts.get("scr_util")!;
    expect(s.folder).toBe("Scripts");
    expect(s.file?.relativePath).toBe("scripts/scr_util/scr_util.gml");

    const r = project.rooms.get("rm_test")!;
    expect(r.layers).toEqual(["Instances", "Nested", "Background"]);
    expect(r.creationOrder).toEqual(["inst_A", "inst_B"]);
    expect(r.creationCode?.kind).toBe("room-creation");
    expect(r.instances.map((i) => [i.name, i.object, i.layer])).toEqual([
      ["inst_A", "obj_child", "Instances"],
      ["inst_B", "obj_parent", "Nested"],
    ]);
    const a = r.instances[0]!;
    expect(a.creationCode?.kind).toBe("instance-creation");
    expect(a.creationCode?.instance).toEqual({ room: "rm_test", name: "inst_A", object: "obj_child" });
    expect(a.properties).toEqual([{ name: "hp", value: "5", definedOn: "obj_parent" }]);
    expect(r.instances[1]!.creationCode).toBeNull();
  });

  it("collects all GML files and ignores prefabs", () => {
    const rels = project.gmlFiles.map((f) => f.relativePath).sort();
    expect(rels).toEqual(
      [
        "objects/obj_child/Collision_obj_parent.gml",
        "objects/obj_child/Create_0.gml",
        "objects/obj_child/Other_10.gml",
        "objects/obj_child/Step_2.gml",
        "objects/obj_parent/Create_0.gml",
        "objects/obj_parent/Draw_64.gml",
        "objects/obj_parent/Step_0.gml",
        "rooms/rm_test/InstanceCreationCode_inst_A.gml",
        "rooms/rm_test/RoomCreationCode.gml",
        "scripts/scr_util/scr_util.gml",
      ].sort(),
    );
    for (const f of project.gmlFiles) expect(path.isAbsolute(f.path) && !f.path.includes("\\")).toBe(true);
  });

  it("resolves inheritance", () => {
    expect(objectAncestors(project, "obj_grandchild").map((o) => o.name)).toEqual(["obj_child", "obj_parent"]);
    expect(objectChildren(project, "obj_parent").map((o) => o.name)).toEqual(["obj_child"]);
    expect(objectDescendants(project, "obj_parent").map((o) => o.name)).toEqual(["obj_child", "obj_grandchild"]);

    expect(findEventFile(project, "obj_child", 3, 2)?.listed).toBe(false);
    expect(findEventFile(project, "obj_child", 4, 0, "obj_parent")?.relativePath).toBe(
      "objects/obj_child/Collision_obj_parent.gml",
    );
    expect(findEventFile(project, "obj_child", 8, 0)).toBeNull();

    const create = resolveInheritedEvent(project, "obj_grandchild", 0, 0);
    expect(create?.object.name).toBe("obj_child");
    const step = resolveInheritedEvent(project, "obj_grandchild", 3, 0);
    expect(step?.object.name).toBe("obj_parent");
    expect(step?.file?.relativePath).toBe("objects/obj_parent/Step_0.gml");
    // Step_2 on obj_child is unlisted, so End Step is not defined anywhere.
    expect(resolveInheritedEvent(project, "obj_grandchild", 3, 2)).toBeNull();
    // Listed but missing file.
    const alarm = resolveInheritedEvent(project, "obj_child", 2, 1);
    expect(alarm?.object.name).toBe("obj_child");
    expect(alarm?.file).toBeNull();
  });

  it("records diagnostics instead of throwing", () => {
    const msgs = project.diagnostics.map((d) => `${d.severity}: ${d.message}`);
    expect(msgs.some((m) => m.startsWith("warning:") && m.includes("Step_2.gml") && m.includes("not listed"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("warning:") && m.includes("Alarm 1") && m.includes("no GML file"))).toBe(true);
    expect(msgs.some((m) => m.includes("InstanceCreationCode_inst_Gone.gml"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("error:") && m.includes("Cannot parse"))).toBe(true);
    const broken = project.objects.get("obj_broken");
    expect(broken?.events).toEqual([]);
    expect(project.diagnostics.every((d) => d.file === null || !d.file.includes("\\"))).toBe(true);
  });

  it("throws only when the .yyp is missing", () => {
    expect(() => loadProject(path.join(tmp, "Nope.yyp"))).toThrow();
    expect(() => loadProject(path.join(tmp, "objects"))).toThrow(/No \.yyp/);
  });
});

/**
 * Optional smoke test against a real project: set GML_TEST_PROJECT to a
 * .yyp path (or its folder) to run it.
 */
const REAL_PROJECT = process.env["GML_TEST_PROJECT"];

describe.skipIf(!REAL_PROJECT)("real project smoke test", () => {
  let project: Project;
  let ms = 0;

  beforeAll(() => {
    const t0 = performance.now();
    project = loadProject(REAL_PROJECT!);
    ms = performance.now() - t0;
    console.log(
      `${project.name}: loaded in ${ms.toFixed(0)} ms; ${project.resources.size} resources, ${project.objects.size} objects, ` +
        `${project.scripts.size} scripts, ${project.rooms.size} rooms, ${project.gmlFiles.length} GML files, ` +
        `${project.diagnostics.length} diagnostics`,
    );
  });

  it("loads without errors and every GML file exists", () => {
    expect(project.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    for (const f of project.gmlFiles) expect(fs.existsSync(f.path)).toBe(true);
  });

  it("resolves every object's parent and ancestry", () => {
    for (const o of project.objects.values()) {
      if (o.parent) expect(project.objects.has(o.parent)).toBe(true);
      expect(() => objectAncestors(project, o.name)).not.toThrow();
    }
  });

  it("links instance creation code to existing instances", () => {
    for (const f of project.gmlFiles.filter((g) => g.kind === "instance-creation")) {
      const room = project.rooms.get(f.owner)!;
      expect(room.instances.some((i) => i.name === f.instance?.name)).toBe(true);
    }
  });
});
