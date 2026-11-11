import { describe, expect, it } from "vitest";
import { diagnose } from "../../testing.js";
import { GM1000, GM1001, GM1005, GM1013, GM1014, GM1019, GM1020, GM1021, GM1100, GM2022 } from "./index.js";

const codes = (d: Array<{ code: string; line: number }>) => d.map((x) => `${x.code}@${x.line}`);

describe("GM1100 syntax errors", () => {
  it("reports parse errors", () => {
    expect(codes(diagnose(GM1100, { "scripts/s/s.gml": "a = ;" }))).toEqual(["GM1100@1"]);
  });
});

describe("GM1000/GM1001", () => {
  it("allows break/continue in loops, break in switch", () => {
    const code = "repeat (3) { break; }\nwhile (a) continue;\nswitch (x) { case 1: break; }\nwith (obj_a) break;";
    expect(diagnose([GM1000, GM1001], { "scripts/s/s.gml": code, "objects/obj_a/Create_0.gml": "" })).toEqual([]);
  });
  it("reports outside loops, including inside functions within loops", () => {
    const code = "break;\ncontinue;\nrepeat (2) { var f = function() { break; }; }\nswitch (x) { case 1: continue; }";
    expect(codes(diagnose([GM1000, GM1001], { "scripts/s/s.gml": code }))).toEqual(["GM1000@1", "GM1001@2", "GM1000@3", "GM1001@4"]);
  });
});

describe("GM1021 undefined functions", () => {
  it("reports unknown functions in object code", () => {
    const d = diagnose(GM1021, { "objects/obj_a/Step_0.gml": "make_gaem();\nshow_debug_message(1);\nhelper();", "scripts/helper/helper.gml": "function helper() {}" });
    expect(d.map((x) => x.message)).toEqual(["The function or script 'make_gaem' does not exist."]);
  });
  it("accepts method variables declared on the object or ancestors", () => {
    const d = diagnose(GM1021, {
      files: {
        "objects/obj_p/Create_0.gml": "Attack = function() {};",
        "objects/obj_c/Step_0.gml": "Attack();",
      },
      objects: { obj_c: { parent: "obj_p" } },
    });
    expect(d).toEqual([]);
  });
  it("stays silent where self is unknown", () => {
    expect(diagnose(GM1021, { "scripts/s/s.gml": "function f() { whatever(); }" })).toEqual([]);
  });
});

describe("GM1019/GM1020 argument counts", () => {
  it("checks built-ins", () => {
    const d = diagnose([GM1019, GM1020], { "scripts/s/s.gml": "x = clamp(lerp(a, b, 0.5, 0, 100));" });
    expect(d.map((x) => x.message)).toEqual([
      "The function 'clamp' takes no less than 3 arguments but 1 is provided.",
      "The function 'lerp' takes no more than 3 arguments but 5 are provided.",
    ]);
  });
  it("checks user functions, optional params and argument_count", () => {
    const code = [
      "function a(x, y) {}",
      "function b(x, y = 1) {}",
      "function c() { return argument_count; }",
      "/// @param {Real} x\n/// @param {Real} [y]\nfunction d(x, y) {}",
      "a(1); b(1); c(1, 2, 3); d(1); a(1, 2, 3);",
    ].join("\n");
    const d = diagnose([GM1019, GM1020], { "scripts/s/s.gml": code });
    expect(d.map((x) => x.message)).toEqual([
      "The function 'a' takes no less than 2 arguments but 1 is provided.",
      "The function 'a' takes no more than 2 arguments but 3 are provided.",
    ]);
  });
});

describe("GM1005 missing argument", () => {
  it("reports omitted required arguments", () => {
    const d = diagnose(GM1005, { "scripts/s/s.gml": "function f(a, b, c = 1) {}\nf(1, , 2);\nf(1, 2, );" });
    expect(d.map((x) => x.message)).toEqual(["Argument 'b' must be provided."]);
  });
});

describe("GM2022 unused pure result", () => {
  it("reports discarded pure calls (e.g. a discarded max())", () => {
    const code = "if (coyote_frames > 0) max(0, coyote_frames - 1);\nx = max(1, 2);\n/// @pure\nfunction p() { return 1; }\np();";
    const d = diagnose(GM2022, { "objects/obj_a/Step_0.gml": "", "scripts/s/s.gml": code });
    expect(codes(d)).toEqual(["GM2022@1", "GM2022@5"]);
  });
});

describe("GM1013 undeclared variables", () => {
  it("reports reads of variables no code declares (a typo)", () => {
    const d = diagnose(GM1013, {
      "objects/obj_player/Create_0.gml": "jump_speed = 1;\njump_speed_crouch = 2;",
      "objects/obj_player/Step_2.gml": "y = crouching ? jump_speed_crouched : jump_speed;\ncrouching = false;",
    });
    expect(d.map((x) => x.message)).toEqual(["Reference to variable 'jump_speed_crouched' which has not been previously declared in 'obj_player'."]);
  });
  it("knows inheritance, with-blocks, instance_create structs and other objects' writes", () => {
    const d = diagnose(GM1013, {
      files: {
        "objects/obj_parent/Create_0.gml": "hp = 3;",
        "objects/obj_child/Step_0.gml": "show_debug_message(hp + mana + speedy + boost + armour);",
        "objects/obj_spawner/Create_0.gml": "with (obj_child) mana = 1;\nobj_child.speedy = 2;\ninstance_create_layer(0, 0, \"I\", obj_child, { boost: 1 });",
        "rooms/rm/InstanceCreationCode_inst_1.gml": "armour = 1;",
      },
      objects: { obj_child: { parent: "obj_parent" } },
      instances: { inst_1: { room: "rm", object: "obj_child" } },
    });
    expect(d).toEqual([]);
  });
  it("reports obj.var reads and constructor fields", () => {
    const d = diagnose(GM1013, {
      "objects/obj_a/Create_0.gml": "hp = 1;",
      "objects/obj_b/Step_0.gml": "x = obj_a.hp + obj_a.mp;",
      "scripts/vec/vec.gml": "function Vec() constructor { x = 0; static len = function() { return x + z; }; }",
    });
    expect(d.map((x) => x.message)).toEqual([
      "Reference to variable 'mp' which has not been previously declared in 'obj_a'.",
      "Reference to variable 'z' which has not been previously declared in 'Vec'.",
    ]);
  });
  it("stays silent when names are written dynamically", () => {
    const d = diagnose(GM1013, {
      "objects/obj_a/Create_0.gml": "variable_instance_set(id, name, 1);",
      "objects/obj_a/Step_0.gml": "x = anything;",
    });
    expect(d).toEqual([]);
  });
});

describe("GM1014 enum members", () => {
  it("reports unknown members", () => {
    const d = diagnose(GM1014, { "scripts/s/s.gml": "enum FRUIT { APPLE, CANTALOUPE }\nx = FRUIT.KIWI;\ny = FRUIT.APPLE;" });
    expect(d.map((x) => x.message)).toEqual(["The enum 'FRUIT' does not contain the value 'KIWI'."]);
  });
});
