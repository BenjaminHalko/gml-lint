import { describe, expect, it } from "vitest";
import { diagnose } from "../../testing.js";
import { GM1009, GM1010, GM1011, GM1028, GM1063 } from "./index.js";

const at = (d: Array<{ code: string; line: number }>) => d.map((x) => `${x.code}@${x.line}`);
const s = (code: string) => ({ "scripts/s/s.gml": code });

describe("GM1009 arithmetic on constants and assets", () => {
  it("reports flags added with + and asset arithmetic", () => {
    const d = diagnose(GM1009, {
      files: s("var _a = fa_readonly + fa_archive;\nroom_goto(room + 1);\nvar _o = obj_a - 1;"),
      assets: { obj_a: "object" },
    });
    expect(d.map((x) => x.message)).toEqual([
      "Operation + between types 'Constant.FileAttribute' and 'Constant.FileAttribute' may result in unexpected behavior or an error during runtime.",
      "Operation + between types 'Asset.GMRoom' and 'Real' may result in unexpected behavior or an error during runtime.",
      "Operation - between types 'Asset.GMObject' and 'Real' may result in unexpected behavior or an error during runtime.",
    ]);
  });
  it("reports chained flags once", () => {
    expect(at(diagnose(GM1009, s("var _a = fa_readonly + fa_archive + fa_readonly;")))).toEqual(["GM1009@1"]);
  });
  it("allows |, comparisons, unknown operands and plain numeric constants", () => {
    const d = diagnose(GM1009, s("var _a = fa_readonly | fa_archive;\nif (room == rm) {}\nvar _b = pi * 2;\nvar _c = c_white + whatever;"));
    expect(d).toEqual([]);
  });
});

describe("GM1010 invalid operations", () => {
  it("reports String + Real, struct arithmetic and undefined operands", () => {
    const code = [
      'var _s = "a" + 1;',
      'var _t = 2 + "b";',
      "var _i1 = { price: 10 };\nvar _i2 = { price: 20 };\nvar _d = _i2 - _i1;",
      "function nothing() {}\nvar _v = nothing() + 1;",
      'var _n = ""; _n += 5;',
    ].join("\n");
    expect(at(diagnose(GM1010, s(code)))).toEqual(["GM1010@1", "GM1010@2", "GM1010@5", "GM1010@7", "GM1010@8"]);
    expect(diagnose(GM1010, s('var _s = "a" + 1;'))[0]!.message).toBe("Cannot perform + operation between types 'String' and 'Real'.");
  });
  it("allows valid, unknown and maybe-valid operations", () => {
    const code = [
      'var _s = "a" + "b";',
      "var _n = 1 + 2 * true;",
      'var _r = "ab" * 3;',
      "var _x = unknown_thing + 1;",
      "var _m = undefined;\n_m = 5;\nvar _y = _m + 1;",
      "var _i = { a: 1 };\nif (_i == undefined) {}",
    ].join("\n");
    expect(diagnose(GM1010, s(code))).toEqual([]);
  });
});

describe("GM1011 implicit Bool casts", () => {
  it("reports strings, arrays, structs and undefined in conditions", () => {
    const code = 'var _c = [];\nif (_c) {}\nwhile ("x") {}\nvar _d = !{};\nvar _e = _c ? 1 : 2;\nif (true && _c) {}\nfunction f() {}\nif (f()) {}';
    expect(at(diagnose(GM1011, s(code)))).toEqual(["GM1011@2", "GM1011@3", "GM1011@4", "GM1011@5", "GM1011@6", "GM1011@8"]);
    expect(diagnose(GM1011, s("if ([]) {}"))[0]!.message).toBe("Implicit cast of type 'Array' to 'Bool' may result in unexpected behavior or an error during runtime.");
  });
  it("allows bools, reals, unknowns and maybe-undefined values", () => {
    const code = "var _a = true;\nvar _b = 1234;\nif (_a) {}\nif (_b) {}\nif (thing) {}\nvar _s = undefined;\nif (cond) _s = {};\nif (_s) {}\nif (instance_exists(obj_a)) {}";
    expect(diagnose(GM1011, { files: s(code), assets: { obj_a: "object" } })).toEqual([]);
  });
});

describe("GM1028 accessors", () => {
  it("reports accessors that do not match the data structure", () => {
    const code = "var _l = ds_list_create();\nvar _a = _l[? 0];\nvar _m = ds_map_create();\nvar _b = _m[| 0];\nvar _c = _l[0];\nvar _arr = [1];\nvar _d = _arr[$ \"k\"];\nvar _s = {};\nvar _e = _s[| 0];";
    const d = diagnose(GM1028, s(code));
    expect(at(d)).toEqual(["GM1028@2", "GM1028@4", "GM1028@5", "GM1028@7", "GM1028@9"]);
    expect(d[0]!.message).toBe("Accessor is intended for type of 'Id.DsMap' but 'Id.DsList' appears instead.");
  });
  it("allows the right accessors, legacy numeric handles and unknown types", () => {
    const code = "var _l = ds_list_create();\nvar _a = _l[| 0];\nvar _m = ds_map_create();\nvar _b = _m[? \"k\"];\nvar _g = ds_grid_create(2, 2);\nvar _c = _g[# 0, 0];\nvar _s = {};\nvar _d = _s[$ \"k\"];\nvar _n = 0;\nvar _e = _n[| 0];\nvar _f = whatever[? 1];\nvar _h = self[$ \"x\"];";
    expect(diagnose(GM1028, { "objects/obj_a/Create_0.gml": code })).toEqual([]);
  });
});

describe("GM1063 ternary types", () => {
  it("reports differing branch types", () => {
    const d = diagnose(GM1063, s('var _a = cond ? 1 : "a";'));
    expect(d.map((x) => x.message)).toEqual(["Ternary may yield differing types 'Real' and 'String'."]);
  });
  it("allows same types, undefined and unknowns", () => {
    expect(diagnose(GM1063, s("var _a = cond ? 1 : 2;\nvar _b = cond ? {} : undefined;\nvar _c = cond ? whatever : \"a\";\nvar _d = cond ? true : 0;"))).toEqual([]);
  });
});
