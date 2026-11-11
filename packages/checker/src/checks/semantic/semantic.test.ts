import { describe, expect, it } from "vitest";
import { diagnose, testSpec } from "../../testing.js";
import {
  GM1008, GM1012, GM1017, GM1023, GM1024, GM1030, GM1031, GM1050, GM1052, GM1054, GM1058,
  GM2016, GM2017, GM2018, GM2023, GM2025, GM2039, GM2040, GM2043, semanticChecks,
} from "./index.js";

const codes = (d: Array<{ code: string; line: number }>) => d.map((x) => `${x.code}@${x.line}`);
const messages = (d: Array<{ message: string }>) => d.map((x) => x.message);

const EVENT_SPEC = testSpec(`<?xml version="1.0" encoding="utf-8"?>
<GameMakerLanguageSpec RuntimeVersion="test" Module="Events"><Functions>
<Function Name="event_perform_object" Deprecated="false" ReturnType="Undefined" Pure="false"><Parameter Name="obj" Type="Asset.GMObject" Optional="false"></Parameter><Parameter Name="type" Type="Constant.EventType" Optional="false"></Parameter><Parameter Name="numb" Type="Real" Optional="false"></Parameter></Function>
</Functions><Variables></Variables><Constants>
<Constant Name="ev_other" Class="EventType" Type="Constant.EventType" Deprecated="false"></Constant>
<Constant Name="ev_user0" Class="EventNumber" Type="Real" Deprecated="false"></Constant>
<Constant Name="ev_user1" Class="EventNumber" Type="Real" Deprecated="false"></Constant>
</Constants><Structures></Structures><Enumerations></Enumerations></GameMakerLanguageSpec>`);

describe("semanticChecks", () => {
  it("has unique codes and kebab-case names", () => {
    const list = semanticChecks.map((c) => c.meta.code);
    expect(new Set(list).size).toBe(list.length);
    for (const c of semanticChecks) {
      expect(c.meta.name).toMatch(/^[a-z]+(-[a-z0-9]+)*$/);
      expect(c.meta.feather).toBe(true);
    }
  });
});

describe("GM1008 read-only built-ins", () => {
  it("reports writes, compound writes and ++ to read-only variables", () => {
    const code = 'working_directory = "a";\nfps += 1;\ninstance_count++;\nother.id = 3;\nx = 1;\nroom_width = 3;';
    const d = diagnose(GM1008, { "objects/obj_a/Collision_obj_b.gml": code, "objects/obj_b/Create_0.gml": "" });
    expect(codes(d)).toEqual(["GM1008@1", "GM1008@2", "GM1008@3", "GM1008@4"]);
    expect(d[0]!.message).toBe("The variable 'working_directory' is readonly and cannot be assigned to.");
  });
  it("allows instance built-ins as constructor fields and shadowing locals", () => {
    const code = "function Thing() constructor { id = 1; object_index = 2; }\nfunction f() { var fps = 1; fps = 2; }";
    expect(diagnose(GM1008, { "scripts/s/s.gml": code })).toEqual([]);
  });
});

describe("GM1012 malformed variable addressing", () => {
  it("reports dots on literals and definitely non-container values", () => {
    const code = 'var _d = "name".length;\nvar _s = "abc";\nvar _e = _s.len;\nvar _n = string(1).x;\nvar _b = true.x;';
    expect(codes(diagnose(GM1012, { "scripts/s/s.gml": code }))).toEqual(["GM1012@1", "GM1012@3", "GM1012@4", "GM1012@5"]);
  });
  it("stays silent on structs, objects, unknowns and numeric variables (legacy ids)", () => {
    const code = "var _a = { name: 1 };\nvar _b = _a.name;\nvar _c = obj_a.x;\nvar _n = 100001;\nvar _x = _n.x;\nfunction f(p) { return p.x; }";
    expect(diagnose(GM1012, { "scripts/s/s.gml": code, "objects/obj_a/Create_0.gml": "" })).toEqual([]);
  });
});

describe("GM1017/GM1023/GM1024 deprecations", () => {
  it("reports deprecated built-in and @deprecated user functions", () => {
    const code = '/// @deprecated\nfunction make_game() {}\nusername = get_string("Username:", "");\nmake_game();\nx = get_string_async("a", "");';
    const d = diagnose(GM1017, { "scripts/s/s.gml": code });
    expect(messages(d)).toEqual([
      "The function 'get_string' is deprecated and usage is discouraged.",
      "The function 'make_game' is deprecated and usage is discouraged.",
    ]);
  });
  it("reports deprecated constants and variables", () => {
    const d = diagnose([GM1023, GM1024], {
      "objects/obj_a/Step_0.gml": "if (os_type == os_win32) score++;\nif (os_type == os_windows) other.score = 1;\nvar _p = obj_a.x;",
    });
    expect(messages(d)).toEqual([
      "The constant 'os_win32' is deprecated and usage is discouraged.",
      "The built-in variable 'score' is deprecated and usage is discouraged.",
    ]);
  });
  it("is silent on non-deprecated names", () => {
    expect(diagnose([GM1017, GM1023, GM1024], { "scripts/s/s.gml": "function f() {}\nf();\nx = c_white + room_width;" })).toEqual([]);
  });
});

describe("GM1030 reserved identifiers", () => {
  it("reports var/static/macro names that are built-ins or keywords", () => {
    const code = "var image_index = 1;\nvar max = 2;\nfunction f() { static fps = 0; var other = 1; }\n#macro pi 3";
    const d = diagnose(GM1030, { "objects/obj_a/Create_0.gml": code });
    expect(d.map((x) => x.text)).toEqual(["image_index", "max", "fps", "other", "pi"]);
    expect(d[0]!.message).toBe("The identifier 'image_index' is reserved and cannot be used as a variable or macro name.");
  });
  it("allows instance built-ins in constructors, ordinary names and parameters", () => {
    const code = "function SpriteData() constructor { var image_index = 1; }\nvar _image_index = 1;\nfunction g(x, y) {}";
    expect(diagnose(GM1030, { "scripts/s/s.gml": code })).toEqual([]);
  });
});

describe("GM1031 assignment to assets/constants", () => {
  it("reports assignments to assets, constants and enums", () => {
    const code = "obj_control = 75;\npi = 1.618;\nspr_a += 1;\nFRUIT = 1;\nenum FRUIT { APPLE }";
    const d = diagnose(GM1031, { files: { "objects/obj_control/Step_0.gml": code }, assets: { spr_a: "sprite" } });
    expect(codes(d)).toEqual(["GM1031@1", "GM1031@2", "GM1031@3", "GM1031@4"]);
    expect(d[0]!.message).toBe("The name 'obj_control' is an asset or constant and cannot be assigned to.");
  });
  it("ignores notes, locals and ordinary variables", () => {
    const code = "tutorial = false;\nvar obj_control = 1;\nobj_control = 2;\ncontrol = 75;";
    expect(diagnose(GM1031, { files: { "objects/obj_control/Step_0.gml": code }, assets: { tutorial: "note" } })).toEqual([]);
  });
});

describe("GM1050 locals accessed with a dot", () => {
  it("reports self./other. access to a local the object does not declare", () => {
    const d = diagnose(GM1050, { "objects/obj_a/Create_0.gml": "var _condition = false;\nif (self._condition) {}" });
    expect(messages(d)).toEqual(["The identifier '_condition' is declared as a local variable and cannot be accessed in this way."]);
  });
  it("is silent when an instance variable or field of that name exists", () => {
    const d = diagnose(GM1050, {
      "objects/obj_a/Create_0.gml": "hp = 1;\nvar hp2 = 1;\nvar hp = self.hp;",
      "scripts/v/v.gml": "function Vec(x, y) constructor { self.x = x; self.y = y; }",
    });
    expect(d).toEqual([]);
  });
});

describe("GM1052 delete on non-structs", () => {
  it("reports delete of arrays and numbers", () => {
    const code = "values = [2, 403, 202];\ndelete values;\nvar _n = 5;\ndelete _n;";
    const d = diagnose(GM1052, { "objects/obj_a/Step_0.gml": code });
    expect(codes(d)).toEqual(["GM1052@2", "GM1052@4"]);
    expect(d[0]!.message).toBe("The delete operator can only act on a variable of type 'struct'.");
  });
  it("is silent for structs, unions and unknowns", () => {
    const code = "var _s = {};\ndelete _s;\nvar _u = undefined;\n_u = new Foo();\ndelete _u;\nfunction Foo() constructor {}\nfunction f(p) { delete p; }";
    expect(diagnose(GM1052, { "scripts/s/s.gml": code })).toEqual([]);
  });
});

describe("GM1054 constructor parents", () => {
  it("reports missing parents and parents not marked constructor", () => {
    const d = diagnose(GM1054, {
      "scripts/a/a.gml": "function vec2() : vec() constructor {}",
      "scripts/Base/Base.gml": "function Base(_f) { file = _f; }",
      "scripts/Derived/Derived.gml": 'function Derived() : Base("a") constructor {}',
    });
    expect(messages(d).sort()).toEqual([
      "Cannot inherit from 'Base' as it is not a constructor function.",
      "Cannot inherit from non-existent function 'vec'.",
    ]);
  });
  it("accepts real constructors", () => {
    expect(diagnose(GM1054, { "scripts/a/a.gml": "function vec() constructor {}\nfunction vec2() : vec() constructor {}" })).toEqual([]);
  });
});

describe("GM1058 new on non-constructors", () => {
  it("reports new on plain functions and built-ins", () => {
    const d = diagnose(GM1058, { "scripts/a/a.gml": "function item() {}\nsword = new item();\nb = new show_message();" });
    expect(messages(d)).toEqual([
      "Cannot 'new' the identifier 'item' as it is not a constructor function.",
      "Cannot 'new' the identifier 'show_message' as it is not a constructor function.",
    ]);
  });
  it("accepts constructors and unknown callees", () => {
    expect(diagnose(GM1058, { "scripts/a/a.gml": "function item() constructor {}\nsword = new item();\nfunction f(c) { return new c(); }" })).toEqual([]);
  });
});

describe("GM2016 instance variables outside Create", () => {
  it("reports variables only ever declared in other events, once per object", () => {
    const d = diagnose(GM2016, {
      "objects/obj_a/Create_0.gml": "ammo_initialised = false;",
      "objects/obj_a/Step_0.gml": "if (!ammo_initialised) { ammo = 0; ammo_initialised = true; }\nammo++;\nammo = 3;",
    });
    expect(messages(d)).toEqual(["Instance variable 'ammo' declared outside of Create event, declare with 'var' or move to Create event."]);
    expect(codes(d)).toEqual(["GM2016@1"]);
  });
  it("respects parents, children, Variable Definitions, other writers and built-ins", () => {
    const d = diagnose(GM2016, {
      files: {
        "objects/obj_p/Create_0.gml": "hp = 1;",
        "objects/obj_c/Step_0.gml": "hp = 2;\nmana = 1;\nboost = 1;\nspeed = 3;\nchild_thing = 1;",
        "objects/obj_spawner/Create_0.gml": "with (obj_c) boost = 0;",
        "objects/obj_gc/Create_0.gml": "child_thing = 0;",
      },
      objects: { obj_c: { parent: "obj_p", properties: ["mana"] }, obj_gc: { parent: "obj_c" } },
    });
    expect(d).toEqual([]);
  });
});

describe("GM2017 naming", () => {
  it("uses Feather's documented defaults", () => {
    const code = "var s = 1;\nenum size { small, Medium }\nfunction Show() {}\nfunction Vec() constructor {}\n#macro max_hp 3";
    const d = diagnose(GM2017, { "scripts/s/s.gml": code });
    expect(messages(d)).toEqual([
      "Inconsistent naming. Recommended name is '_s'.",
      "Inconsistent naming. Recommended name is 'SIZE'.",
      "Inconsistent naming. Recommended name is 'SMALL'.",
      "Inconsistent naming. Recommended name is 'show'.",
      "Inconsistent naming. Recommended name is 'MAX_HP'.",
    ]);
  });
  it("checks instance variables once per object and accepts options", () => {
    const files = { "objects/obj_a/Create_0.gml": "moveSpeed = 1;\nmoveSpeed = 2;\nhp = 1;", "scripts/s/s.gml": "function doThing(_a) { var myVar = 1; }" };
    expect(messages(diagnose(GM2017, files)).filter((m) => m.includes("move"))).toEqual(["Inconsistent naming. Recommended name is 'move_speed'."]);
    const d = diagnose(GM2017, files, {
      options: { GM2017: { instanceVariable: "lowerCamelCase", function: "lowerCamelCase", localVariable: "^[a-z][A-Za-z]*$", ignore: ["hp"] } },
    });
    expect(d).toEqual([]);
  });
});

describe("GM2018 uninitialised var in loop", () => {
  it("reports a declaration that may keep the previous iteration's value", () => {
    const code = "for (var i = 0; i < 10; ++i) {\n  var _elem;\n  if (i == 0) _elem = 1;\n  else if (i < 5) _elem = 2;\n  show_debug_message(_elem);\n}";
    const d = diagnose(GM2018, { "scripts/s/s.gml": code });
    expect(codes(d)).toEqual(["GM2018@2"]);
    expect(d[0]!.message).toBe("Potentially dangerous variable declaration.");
  });
  it("is silent when every path assigns it first, outside loops, or with an initialiser", () => {
    const code = [
      "repeat (3) { var _a; if (random(1) < 0.5) { _a = 1; } else { _a = 2; } show_debug_message(_a); }",
      "repeat (3) { var _b; _b = 1; show_debug_message(_b); var _c = 0; }",
      "var _d; show_debug_message(_d);",
    ].join("\n");
    expect(diagnose(GM2018, { "scripts/s/s.gml": code })).toEqual([]);
  });
});

describe("GM2023 argument evaluation order", () => {
  it("reports two impure calls in one argument list", () => {
    const d = diagnose(GM2023, { "scripts/s/s.gml": "x = max(ds_list_create(), ds_map_create());" });
    expect(codes(d)).toEqual(["GM2023@1"]);
  });
  it("ignores pure calls and single calls", () => {
    expect(diagnose(GM2023, { "scripts/s/s.gml": "x = max(abs(a), floor(b));\ny = max(ds_list_create(), 2);" })).toEqual([]);
  });
});

describe("GM2025 user events", () => {
  it("reports user events nobody in the hierarchy defines", () => {
    const d = diagnose(
      GM2025,
      {
        "objects/obj_a/Create_0.gml": "event_user(1);\nevent_perform(ev_other, ev_user1);\nevent_user(0);\nevent_perform_object(obj_b, ev_other, ev_user0);",
        "objects/obj_a/Other_10.gml": "",
        "objects/obj_b/Create_0.gml": "",
      },
      { spec: EVENT_SPEC },
    );
    expect(codes(d)).toEqual(["GM2025@1", "GM2025@2", "GM2025@4"]);
    expect(d[0]!.message).toBe("Reference to non-existent event 'User Event 1'.");
  });
  it("accepts events defined by ancestors or descendants, and unknown contexts", () => {
    const d = diagnose(
      GM2025,
      {
        files: {
          "objects/obj_p/Create_0.gml": "event_user(0);\nevent_user(1);",
          "objects/obj_p/Other_10.gml": "",
          "objects/obj_c/Other_11.gml": "event_user(0);",
          "scripts/s/s.gml": "function f() { event_user(5); }",
        },
        objects: { obj_c: { parent: "obj_p" } },
      },
      { spec: EVENT_SPEC },
    );
    expect(d).toEqual([]);
  });
});

describe("GM2039 script asset called like a function", () => {
  it("reports calls to scripts without a same-named function", () => {
    const d = diagnose(GM2039, { "scripts/my_function/my_function.gml": 'show_debug_message("x");', "objects/obj_a/Create_0.gml": "my_function();\nother_fn();", "scripts/lib/lib.gml": "function other_fn() {}" });
    expect(codes(d)).toEqual(["GM2039@1"]);
  });
  it("accepts scripts declaring the function", () => {
    expect(diagnose(GM2039, { "scripts/my_function/my_function.gml": "function my_function() {}", "objects/obj_a/Create_0.gml": "my_function();" })).toEqual([]);
  });
});

describe("GM2040 event_inherited without parent event", () => {
  it("reports objects without a parent, or whose ancestors lack the event", () => {
    const d = diagnose(GM2040, {
      files: {
        "objects/obj_solo/Step_0.gml": "event_inherited();",
        "objects/obj_parent/Step_2.gml": "",
        "objects/obj_child/Other_4.gml": "event_inherited();",
        "objects/obj_child/Step_0.gml": "event_inherited();",
      },
      objects: { obj_child: { parent: "obj_parent" } },
    });
    expect(d.map((x) => x.file)).toEqual(["objects/obj_child/Other_4.gml", "objects/obj_child/Step_0.gml", "objects/obj_solo/Step_0.gml"]);
    expect(d[0]!.message).toBe("Call to event_inherited() in object with no parent event.");
  });
  it("accepts events defined by any ancestor, including collisions", () => {
    const d = diagnose(GM2040, {
      files: {
        "objects/obj_gp/Step_0.gml": "",
        "objects/obj_gp/Collision_obj_wall.gml": "",
        "objects/obj_parent/Create_0.gml": "",
        "objects/obj_child/Step_0.gml": "event_inherited();",
        "objects/obj_child/Collision_obj_wall.gml": "event_inherited();",
        "objects/obj_wall/Create_0.gml": "",
      },
      objects: { obj_child: { parent: "obj_parent" }, obj_parent: { parent: "obj_gp" } },
    });
    expect(d).toEqual([]);
  });
});

describe("GM2043 local outside its block", () => {
  it("reports use after the declaring block, and before the declaration", () => {
    const code = 'if (a) {\n  var _msg = "x";\n}\n_msg = "test";\nshow_debug_message(_msg);\ni = 0;\nvar i = 34;';
    const d = diagnose(GM2043, { "objects/obj_a/Step_0.gml": code });
    expect(codes(d)).toEqual(["GM2043@4", "GM2043@6"]);
    expect(d[0]!.message).toBe("Attempting to access the local variable '_msg' outside of the scope it was defined in.");
  });
  it("accepts same-block use, outer declarations and for-init variables", () => {
    const code = "var _m;\nif (a) { _m = 1; var _k = 2; _k++; }\n_m = 2;\nfor (var i = 0; i < 3; i++) {}\nshow_debug_message(i);\nif (b) { var _z = 1; }\nvar _z = 3;\n_z++;";
    expect(diagnose(GM2043, { "objects/obj_a/Step_0.gml": code })).toEqual([]);
  });
});
