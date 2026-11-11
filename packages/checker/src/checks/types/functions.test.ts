import { describe, expect, it } from "vitest";
import { diagnose } from "../../testing.js";
import { isDefinite, parseType, T, validateTypeText } from "../../types.js";
import { GM1035, GM1042, GM1043, GM1045, GM1062 } from "./index.js";

const at = (d: Array<{ code: string; line: number }>) => d.map((x) => `${x.code}@${x.line}`);
const s = (code: string) => ({ "scripts/s/s.gml": code });

describe("type model helpers", () => {
  it("isDefinite", () => {
    expect(isDefinite(T.real)).toBe(true);
    expect(isDefinite(parseType("Real|String"))).toBe(true);
    expect(isDefinite(T.unknown)).toBe(false);
    expect(isDefinite(parseType("Any"))).toBe(false);
    expect(isDefinite({ kind: "union", types: [T.real, T.unknown] })).toBe(false);
  });
  it("validateTypeText", () => {
    const ok = ["Real", "Array[Real]", "Array<Array<String>>", "Id.Instance|Undefined", "Struct.Foo", "String, Real", "Asset.GMObject", "Enum.E", "bool", "Constant.Colour", "Vec"];
    for (const t of ok) expect(validateTypeText(t, { isKnownName: (n) => n === "Vec" }), t).toBeNull();
    const bad = ["Reall", "Array[String", "String Array[String]", "Id Instance", "", "Real|", "Asset.GMObjct", "Bool=false", "Real[]"];
    for (const t of bad) expect(validateTypeText(t), t).not.toBeNull();
  });
});

describe("GM1035 inconsistent returns", () => {
  it("reports returns of a different type than established (Feather example)", () => {
    const code = 'function get_random_number2() {\n  if (irandom(100) < 50)\n    return 0;\n  return "1";\n}';
    const d = diagnose(GM1035, s(code));
    expect(at(d)).toEqual(["GM1035@4"]);
    expect(d[0]!.message).toBe("Return type differs from previously established return type.");
  });
  it("allows undefined alongside a type, unknown returns and documented functions", () => {
    const code = 'function a() { if (c) return 1; return undefined; }\nfunction b() { if (c) return 1; return thing; }\n/// @returns {Real}\nfunction d() { if (c) return 1; return "a"; }\nfunction e() { var f = function() { return "s"; }; return 1; }';
    expect(diagnose(GM1035, s(code))).toEqual([]);
  });
});

describe("GM1042 JSDoc parameter names", () => {
  it("reports differing names (Feather example)", () => {
    const code = "/// @func sum(_v1, _v2);\n/// @arg {Array<Real>} _v1 The first vector\n/// @arg {Array<Real>} _v2 The second vector\nfunction sum(_v, _v2) {}";
    const d = diagnose(GM1042, s(code));
    expect(d.map((x) => x.message)).toEqual(["Parameter name '_v' differs from '_v1' specified in jsdoc."]);
    expect(d[0]!.line).toBe(4);
  });
  it("accepts matching names, optional syntax, rest params and missing docs", () => {
    const code = "/// @param {Real} a\n/// @param {Real} [b=1]\n/// @param ...rest\nfunction f(a, b) {}\n/// @param {Real} a\nfunction g(a, b) {}\nfunction h(x) {}\n/// @param {Real} a\nvar m = function(a) {};";
    expect(diagnose(GM1042, s(code))).toEqual([]);
  });
});

describe("GM1045 JSDoc type mismatches", () => {
  it("reports returns and parameter values that differ from the JSDoc type (Feather example)", () => {
    const code = [
      "/// @returns {Id.Instance} A new instance\nfunction return_something() {\n  return \"something\";\n}",
      "/// @param {String} [s]\nfunction f(s = 5) {}",
      "/// @param {Real} n\nfunction g(n) { n = \"x\"; }",
    ].join("\n");
    const d = diagnose(GM1045, s(code));
    expect(d.map((x) => `${x.line}: ${x.message}`)).toEqual([
      "3: Type 'String' differs from type 'Id.Instance' specified in jsdoc.",
      "6: Type 'Real' differs from type 'String' specified in jsdoc.",
      "8: Type 'String' differs from type 'Real' specified in jsdoc.",
    ]);
  });
  it("allows compatible, undefined and unknown values", () => {
    const code = [
      "/// @returns {Real}\nfunction a() { if (c) return undefined; if (d) return true; return thing; }",
      "/// @param {Real} [n]\nfunction b(n = undefined) { n ??= 3; }",
      "/// @returns {Struct.Vec}\nfunction c() { return new Vec3(); }\nfunction Vec() constructor {}\nfunction Vec3() : Vec() constructor {}",
      "/// @returns {Struct}\nfunction d() { return {}; }",
      "/// @returns {Array<Real>}\nfunction e() { return []; }",
      "/// @returns {Bool}\nfunction g() { return 1; }",
      "/// @param {Asset.GMSprite} [spr]\nfunction h(spr = noone) {}",
    ].join("\n");
    expect(diagnose(GM1045, s(code))).toEqual([]);
  });
});

describe("GM1062 malformed JSDoc types", () => {
  it("reports unparseable and unknown types (Feather example)", () => {
    const code = "/// @param {Array[String} _param1\n/// @param {String Array[String]} _param2\n/// @param {Id Instance} _param3\n/// @returns {Reall}\nfunction func(_param1, _param2, _param3) {}";
    const d = diagnose(GM1062, s(code));
    expect(d.map((x) => x.message)).toEqual([
      "Malformed type 'Array[String' in jsdoc.",
      "Malformed type 'String Array[String]' in jsdoc.",
      "Malformed type 'Id Instance' in jsdoc.",
      "Malformed type 'Reall' in jsdoc.",
    ]);
    expect(d[3]!.text).toBe("Reall");
  });
  it("accepts Feather types, constructors and enums", () => {
    const code = "enum E { A }\nfunction Vec() constructor {}\n/// @param {Array[String]} a\n/// @param {String,Array[String]} b\n/// @param {Id.Instance} c\n/// @param {Vec} d\n/// @param {Enum.E|Real} e\n/// @param {Struct.Whatever} f\n/// @param g no type\n/// @returns {Constant.Color}\nfunction func(a, b, c, d, e, f, g) {}";
    expect(diagnose(GM1062, s(code))).toEqual([]);
  });
});

describe("GM1043 type reassignment", () => {
  it("reports locals whose definite type changes (Feather example)", () => {
    const d = diagnose(GM1043, s('var my_var = 5;\nmy_var = "I\'m a string";'));
    expect(d.map((x) => `${x.line}: ${x.message}`)).toEqual(["2: Potentially unintentional type reassignment from 'Real' to 'String'."]);
  });
  it("allows undefined initialisers, same types and unknown values", () => {
    const code = 'var a = undefined;\na = "s";\nvar b = 1;\nb = 2;\nb = true;\nvar c = 1;\nc = thing;\nvar d;\nd = [];\nd = undefined;';
    expect(diagnose(GM1043, s(code))).toEqual([]);
  });
});
