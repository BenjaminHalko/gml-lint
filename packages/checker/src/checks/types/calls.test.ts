import { describe, expect, it } from "vitest";
import { diagnose, testSpec } from "../../testing.js";
import { GM1029, GM1041, GM1044, GM1060 } from "./index.js";

const at = (d: Array<{ code: string; line: number }>) => d.map((x) => `${x.code}@${x.line}`);
const s = (code: string) => ({ "scripts/s/s.gml": code });

describe("GM1041 argument types", () => {
  it("reports definite mismatches against built-ins (the Feather example)", () => {
    const d = diagnose(GM1041, { "objects/obj_a/Create_0.gml": 'var _inst = instance_create_depth(x, y, -100, "obj_player");\ndraw_sprite([], 0, x, y);' });
    expect(d.map((x) => x.message)).toEqual([
      "The type 'String' appears where the type 'Asset.GMObject' is expected.",
      "The type 'Array' appears where the type 'Asset.GMSprite' is expected.",
    ]);
    expect(d[0]!.text).toBe('"obj_player"');
  });
  it("checks JSDoc-typed parameters of user functions and constructors", () => {
    const code = [
      "/// @param {Struct.Vec} v\n/// @param {Real} n\nfunction use_vec(v, n) {}",
      "function Vec() constructor {}\nfunction Vec3() : Vec() constructor {}\nfunction Other() constructor {}",
      '/// @param {Array<Real>} a\nfunction Box(a) constructor {}',
      'use_vec(new Vec3(), "1");\nuse_vec(new Other(), 1);\nvar _b = new Box(["a"]);',
    ].join("\n");
    expect(at(diagnose(GM1041, s(code)))).toEqual(["GM1041@9", "GM1041@10", "GM1041@11"]);
  });
  it("is lenient with numeric handles, scripts, structs-as-instances, noone and undefined", () => {
    const code = [
      "instance_create_depth(x, y, 0, obj_a);",
      "draw_sprite(-1, 0, x, y);",
      "var _l = ds_list_create();\nds_list_destroy(_l);\nds_list_destroy(0);",
      "script_execute(helper);",
      "variable_instance_set({}, \"a\", 1);",
      "instance_destroy(noone);",
      "instance_create_layer(x, y, \"Instances\", obj_a, undefined);",
      "/// @param {Real} n\nfunction f(n) {}\nf(undefined);\nf(whatever);\nf(true);",
      "/// @param {SomeDocName} v\nfunction g(v) {}\ng(1);",
      "array_push([], 1, \"a\");",
    ].join("\n");
    expect(diagnose(GM1041, { files: { "objects/obj_a/Create_0.gml": code, "scripts/helper/helper.gml": "function other_name() {}" } })).toEqual([]);
  });
  it("follows macros, including per-configuration ones that agree (the INPUT_MAX_PLAYERS bug)", () => {
    const code = "#macro MAX_PLAYERS 8\n#macro Demo:MAX_PLAYERS 1\nrepeat (array_length(MAX_PLAYERS)) {}\n#macro MIXED 8\n#macro Demo:MIXED []\nrepeat (array_length(MIXED)) {}";
    expect(diagnose(GM1041, s(code)).map((x) => `${x.line}: ${x.message}`)).toEqual(["3: The type 'Real' appears where the type 'Array' is expected."]);
  });
  it("distrusts element reads, placeholders and variables written through unknown targets", () => {
    const d = diagnose(GM1041, {
      "objects/obj_ps/Create_0.gml": 'obj_to_use = noone;\ninstance_create_layer(0, 0, "I", obj_to_use);\nvar _o = obj_to_use;\ninstance_create_layer(0, 0, "I", _o);',
      "objects/obj_b/Create_0.gml": "var _ps = get_ps();\n_ps.obj_to_use = obj_b;",
      "scripts/s/s.gml": 'var _names = ["a"];\n_names[0] = obj_b;\ninstance_create_depth(0, 0, 0, _names[0]);\nvar _n = undefined;\ninstance_create_depth(0, 0, 0, _n);',
    });
    expect(d).toEqual([]);
  });
  it("leaves String<->Real casts into built-ins to GM1029", () => {
    expect(diagnose(GM1041, s('var _n = string_length(5);\nvar _x = clamp("1", 0, 1);'))).toEqual([]);
  });
});

describe("GM1029 implicit casts", () => {
  it("reports String to Real and Real to String for built-ins", () => {
    const d = diagnose(GM1029, { "objects/obj_a/Draw_0.gml": 'var _x = "1234";\ndraw_sprite(sprite_index, image_index, _x, y);\nvar _n = string_length(5);' });
    expect(d.map((x) => x.message)).toEqual([
      "Potentially dangerous or unintended implicit cast from 'String' to 'Real'.",
      "Potentially dangerous or unintended implicit cast from 'Real' to 'String'.",
    ]);
  });
  it("allows explicit conversions and unknown values", () => {
    expect(diagnose(GM1029, { "objects/obj_a/Draw_0.gml": 'draw_sprite(sprite_index, 0, real("1"), y);\nvar _n = string_length(string(5));\nclamp(v, 0, 1);' })).toEqual([]);
  });
});

describe("GM1044 constant groups", () => {
  const spec = testSpec(
    `<GameMakerLanguageSpec><Functions><Function Name="keyboard_check_pressed" ReturnType="Bool"><Parameter Name="key" Type="Constant.VirtualKey,Real" Optional="false"/></Function>` +
      `<Function Name="draw_set_colour_ext" ReturnType="Undefined"><Parameter Name="col" Type="Constant.Colour" Optional="false"/></Function></Functions></GameMakerLanguageSpec>`,
  );
  it("reports constants from another group (Feather example)", () => {
    const d = diagnose(GM1044, s("if mouse_check_button_pressed(vk_left) {}\n#macro KEY vk_space\nmouse_check_button_pressed(KEY);"), { spec });
    expect(d.map((x) => `${x.line}: ${x.message}`)).toEqual([
      "1: Constant is expected to be one of the following: mb_left, mb_middle, mb_right, mb_side1, mb_side2, mb_any, mb_none, m_axisx, m_axisy, m_axisx_gui, m_axisy_gui, m_scroll_up, m_scroll_down",
      "3: Constant is expected to be one of the following: mb_left, mb_middle, mb_right, mb_side1, mb_side2, mb_any, mb_none, m_axisx, m_axisy, m_axisx_gui, m_axisy_gui, m_scroll_up, m_scroll_down",
    ]);
  });
  it("allows the right group, numeric parameters, Colour/Color spellings and non-constants", () => {
    const code = "mouse_check_button_pressed(mb_left);\nkeyboard_check_pressed(mb_left);\ndraw_set_colour_ext(c_white);\nmouse_check_button_pressed(1);\nmouse_check_button_pressed(btn);";
    expect(diagnose(GM1044, s(code), { spec })).toEqual([]);
  });
});

describe("GM1060 calling non-functions", () => {
  it("reports calls to variables holding non-functions (Feather example)", () => {
    const d = diagnose(GM1060, { "objects/obj_a/Create_0.gml": "my_function = 100;\nmy_function();\nvar _s = \"a\";\n_s();\nvar _st = { a: 1 };\n_st.a();" });
    expect(d.map((x) => `${x.line}: ${x.message}`)).toEqual([
      "2: Dangerous call to variable of type 'Real'.",
      "4: Dangerous call to variable of type 'String'.",
    ]);
  });
  it("allows functions, methods, scripts and maybe-functions", () => {
    const d = diagnose(GM1060, {
      "objects/obj_a/Create_0.gml": "cb = undefined;\ncb2 = function() {};\nvar _f = method(self, cb2);\n_f();\ncb2();\nshow_debug_message(1);\nhelper();\nvar _h = helper;\n_h();",
      "objects/obj_a/Step_0.gml": "cb = function() {};\ncb();\nunknown_fn();\n#macro CFG_PROCESSOR undefined\nvar _p = CFG_PROCESSOR;\nif (is_undefined(_p)) _p();\nvar _q = undefined;\n_q();",
      "scripts/helper/helper.gml": "function helper() {}",
    });
    expect(d).toEqual([]);
  });
});
