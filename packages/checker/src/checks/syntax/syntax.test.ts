import { describe, expect, it } from "vitest";
import { createTestProgram, diagnose } from "../../testing.js";
import type { Check } from "../api.js";
import { applyFixes, runChecks } from "../runner.js";
import {
  GM1002, GM1003, GM1004, GM1006, GM1007, GM1015, GM1016, GM1022, GM1025, GM1026, GM1027, GM1032, GM1033, GM1034, GM1036,
  GM1038, GM1040, GM1051, GM1055, GM1056, GM1059, GM1064, GM2004, GM2007, GM2020, GM2044, GM2047, GM2061, syntaxChecks,
} from "./index.js";

const S = "scripts/s/s.gml";
const O = "objects/obj_a/Create_0.gml";
const codes = (d: Array<{ code: string; line: number }>) => d.map((x) => `${x.code}@${x.line}`);
const texts = (d: Array<{ text: string }>) => d.map((x) => x.text);

function fix(check: Check, text: string, path = S): string {
  const program = createTestProgram({ [path]: text });
  const res = runChecks(program, { checks: [check] });
  return applyFixes(text, res).text;
}

describe("syntaxChecks", () => {
  it("has unique codes and names, all Feather", () => {
    expect(new Set(syntaxChecks.map((c) => c.meta.code)).size).toBe(syntaxChecks.length);
    expect(new Set(syntaxChecks.map((c) => c.meta.name)).size).toBe(syntaxChecks.length);
    expect(syntaxChecks.every((c) => c.meta.feather)).toBe(true);
  });
});

describe("GM1002 globalvar initializer", () => {
  it("reports inline initializers only", () => {
    const d = diagnose(GM1002, { [S]: "globalvar gm = 1;\nglobalvar ok;\nvar a = 1;" });
    expect(codes(d)).toEqual(["GM1002@1"]);
  });
});

describe("GM1003 enum values", () => {
  it("reports non-integer values", () => {
    const code = 'enum E { A = -1, B = 0x10, C = E.A + 2, D = 1.5, F = "s", G = 4 / 2, H = 1 / 2, I = (1 << 3) | 1, J = X, K = Y }\n#macro X 3\n#macro Y 0.5';
    const d = diagnose(GM1003, { [S]: code });
    expect(texts(d)).toEqual(["1.5", '"s"', "1 / 2", "Y"]);
  });
  it("accepts constants and unknowns", () => {
    expect(diagnose(GM1003, { [S]: "enum E { A = c_white, B = true, C = OTHER.Z }\nenum OTHER { Z }" })).toEqual([]);
  });
});

describe("GM1004 duplicate enum members", () => {
  it("reports repeats", () => {
    const d = diagnose(GM1004, { [S]: "enum FRUIT { APPLE, PEAR, APPLE }\nenum OTHER { APPLE }" });
    expect(d.map((x) => x.message)).toEqual(["The enum value 'APPLE' has already been previously defined in the enum 'FRUIT'."]);
  });
});

describe("GM1006 duplicate enums", () => {
  it("reports later declarations project-wide", () => {
    const d = diagnose(GM1006, { "scripts/a/a.gml": "enum FRUIT { A }\nenum OK { B }", "scripts/b/b.gml": "enum FRUIT { C }" });
    expect(d.map((x) => `${x.file}:${x.message}`)).toEqual(["scripts/b/b.gml:The enum 'FRUIT' has already been previously declared."]);
  });
});

describe("GM1007 assignment target", () => {
  it("reports non-variables", () => {
    const d = diagnose(GM1007, { [S]: 'get() = 1;\n"a" = 2;\n(f()) = 3;\na = 1;\na.b = 1;\na[0] = 1;\n(a) = 1;\n1 = 2;' });
    expect(codes(d)).toEqual(["GM1007@1", "GM1007@2", "GM1007@3"]);
  });
});

describe("GM1015 divide by zero", () => {
  it("reports literal zero divisors", () => {
    const d = diagnose(GM1015, { [S]: "a = b / 0;\na /= 0;\na %= 0.0;\nc = d mod 0;\ne = f div 0x0;\ng = h / 1;\ni = j / zero;\nk = 0 / l;" });
    expect(codes(d)).toEqual(["GM1015@1", "GM1015@2", "GM1015@3", "GM1015@4", "GM1015@5"]);
  });
});

describe("GM1016/GM1025/GM1027 lone literals", () => {
  it("reports lone literals", () => {
    const d = diagnose([GM1016, GM1025, GM1027], { [S]: 'true;\n1;\n"s";\n#AEF033\n0xFF = 1;\nx = true;\nf(1, "s");\n(false);' });
    expect(codes(d)).toEqual(["GM1016@1", "GM1025@2", "GM1027@3", "GM1025@4", "GM1025@5", "GM1016@8"]);
  });
});

describe("GM1022 assignment expected", () => {
  it("reports bare identifiers and members", () => {
    const d = diagnose(GM1022, { [O]: "username;\nother.x\nx = 1;\nf();" });
    expect(codes(d)).toEqual(["GM1022@1", "GM1022@2"]);
  });
  it("skips statement macros", () => {
    const d = diagnose(GM1022, { [S]: "#macro LOG show_debug_message(1)\nLOG;\nlive_auto_call;\nLOG.x;" });
    expect(d).toEqual([]);
  });
});

describe("GM1026 update target", () => {
  it("reports constants, functions, literals and calls", () => {
    const d = diagnose(GM1026, { [S]: "pi++;\nshow_debug_message--;\n++f();\n1++;\nfunction g() {}\ng++;\nx++;\na.b--;\nc[0]++;\nvar l = 0; l++;" });
    expect(codes(d)).toEqual(["GM1026@1", "GM1026@2", "GM1026@3", "GM1026@4", "GM1026@6"]);
  });
});

describe("GM1032 argument gaps", () => {
  it("reports skipped argumentN indices", () => {
    const d = diagnose(GM1032, { [S]: "function a() { return argument0 + argument2; }\nfunction b() { return argument1 + argument0; }\nfunction c(p) { return argument1; }\nfunction d() { return argument3; }" });
    expect(d.map((x) => `${x.line}:${x.message}`)).toEqual([
      "1:No references to argument 1 but references argument 2.",
      "4:No references to arguments 0, 1, 2 but references argument 3.",
    ]);
  });
});

describe("GM1033 misplaced semicolons", () => {
  it("reports and removes doubled or block-trailing semicolons", () => {
    const code = "var a = 1;;\nif (a) {};\nfunction f() {};\nx = 1;\n;\nwhile (a) { b = 1; } ;\ndo { } until (a);";
    const d = diagnose(GM1033, { [S]: code });
    expect(codes(d)).toEqual(["GM1033@1", "GM1033@2", "GM1033@6"]);
    expect(fix(GM1033, code)).toBe("var a = 1;\nif (a) {}\nfunction f() {};\nx = 1;\n;\nwhile (a) { b = 1; }\ndo { } until (a);");
  });
});

describe("GM1034 argument outside function", () => {
  it("reports file-scope argument references", () => {
    const d = diagnose(GM1034, {
      [O]: "x = argument0;\ny = argument[1];\nn = argument_count;\nf = function() { return argument0; };",
      [S]: "function g() { return argument[0]; }\nvar v = argument1;",
    });
    expect(d.map((x) => `${x.file}:${x.line}`)).toEqual([O + ":1", O + ":2", S + ":2"]);
  });
  it("respects locals named argument", () => {
    expect(diagnose(GM1034, { [O]: "var argument0 = 1;\nx = argument0;" })).toEqual([]);
  });
});

describe("GM1036 array indexing", () => {
  it("reports empty and 2D argument indexing", () => {
    const d = diagnose(GM1036, { [S]: "function f() { return argument[a, b]; }\nx = arr[];\ny = arr[0, 1];\nz = arr[0];" });
    expect(codes(d)).toEqual(["GM1036@1", "GM1036@2"]);
  });
});

describe("GM1038 duplicate macros", () => {
  it("reports same name and config", () => {
    const d = diagnose(GM1038, {
      "scripts/a/a.gml": "#macro dbg show_debug_message\n#macro Release:dbg noop\n#macro ok 1",
      "scripts/b/b.gml": "#macro dbg show_debug_message\n#macro Debug:dbg noop",
    });
    expect(d.map((x) => `${x.file}:${x.line}`)).toEqual(["scripts/b/b.gml:1"]);
  });
});

describe("GM1040 mixed argument styles", () => {
  it("reports functions using both", () => {
    const d = diagnose(GM1040, { [S]: "function a() { var x = argument0; var y = argument[1]; }\nfunction b() { return argument[0] + argument[1]; }\nfunction c() { return argument0; }" });
    expect(codes(d)).toEqual(["GM1040@1"]);
  });
});

describe("GM1051 macro semicolon", () => {
  it("reports and removes the trailing semicolon", () => {
    const code = "#macro A 1;\n#macro B 2 ; // note\n#macro C \"a;b\"\n#macro D 4 // c;";
    const d = diagnose(GM1051, { [S]: code });
    expect(codes(d)).toEqual(["GM1051@1", "GM1051@2"]);
    expect(fix(GM1051, code)).toBe("#macro A 1\n#macro B 2 // note\n#macro C \"a;b\"\n#macro D 4 // c;");
  });
});

describe("GM1055 argumentN with named parameters", () => {
  it("reports argumentN in functions with parameters", () => {
    const d = diagnose(GM1055, { [S]: "function a(p, q) { return argument0 + argument1; }\nfunction b() { return argument0; }\nfunction c(p) { return argument[0]; }" });
    expect(texts(d)).toEqual(["argument0", "argument1"]);
  });
});

describe("GM1056/GM1059 parameters", () => {
  it("reports required after optional, and duplicates", () => {
    const d = diagnose([GM1056, GM1059], { [S]: "function a(p, q = 1, r) {}\nfunction b(p, q, p) {}\nf = function(x = 1, y = 2) {};" });
    expect(d.map((x) => `${x.code}:${x.text}`)).toEqual(["GM1056:r", "GM1059:p"]);
  });
});

describe("GM1064 duplicate global functions", () => {
  it("reports the later declaration with the original's script", () => {
    const d = diagnose(GM1064, {
      "scripts/Script1/Script1.gml": "function make_game() {}\nfunction only_once() {}",
      "scripts/Script2/Script2.gml": "function make_game() {}",
      [O]: "function make_game() {}",
    });
    expect(d.map((x) => `${x.file}:${x.message}`)).toEqual([
      "scripts/Script2/Script2.gml:Redeclaration of global function 'make_game' originally declared in 'Script1'.",
    ]);
  });
});

describe("GM2004 for -> repeat", () => {
  it("reports classic counters that are never used", () => {
    const code = [
      "for (var i = 0; i < n; i++) { array_push(a, 1); }",
      "for (var j = 0; j < n; j++) { a[j] = 1; }",
      "for (var k = 0; k < array_length(a); k++) { array_pop(a); }",
      "for (var m = 0; m <= 10; m += 1) show_debug_message(1);",
      "for (var p = 0; p < 3; p++) {} show_debug_message(p);",
      "for (var q = 0; q < 3; q++) {} for (var q = 0; q < 3; q++) { x = q; }",
      "for (var r = 0; r < 3; r += 2) {}",
    ].join("\n");
    expect(codes(diagnose(GM2004, { [S]: code }))).toEqual(["GM2004@1", "GM2004@4", "GM2004@6"]);
  });
  it("requires a bound that repeat would evaluate the same way", () => {
    const code = "for (var i = 0; i < irandom(3); i++) {}\nfor (var j = 0; j < array_length(a) * 2; j++) { show_debug_message(1); }";
    expect(codes(diagnose(GM2004, { [S]: code }))).toEqual(["GM2004@2"]);
  });
  it("skips instance-variable counters", () => {
    expect(diagnose(GM2004, { [O]: "for (i = 0; i < 3; i++) {}" })).toEqual([]);
  });
});

describe("GM2007 var semicolon", () => {
  it("reports and fixes missing semicolons outside for headers", () => {
    const code = "var a = 1\nvar b;\nfor (var i = 0; i < 1; i++) {}\nstatic s = 1";
    expect(codes(diagnose(GM2007, { [S]: code }))).toEqual(["GM2007@1"]);
    expect(fix(GM2007, code)).toBe("var a = 1;\nvar b;\nfor (var i = 0; i < 1; i++) {}\nstatic s = 1");
  });
});

describe("GM2020 all member access", () => {
  it("reports all.x", () => {
    const d = diagnose(GM2020, { [O]: "all.x = 200;\nwith (all) x = 200;\nv = all;" });
    expect(codes(d)).toEqual(["GM2020@1"]);
  });
});

describe("GM2044 redeclared locals", () => {
  it("reports redeclarations in the same or nested region and parameter shadows", () => {
    const code = [
      "var i = 0;",
      "var i = 1;",
      "for (var j = 0; j < 2; j++) { for (var j = 0; j < 2; j++) {} }",
      "for (var k = 0; k < 2; k++) {}",
      "for (var k = 0; k < 2; k++) {}",
      "if (a) { var t = 1; } else { var t = 2; }",
      "function f(p) { var p = 1; }",
      "switch (x) { case 1: var c = 1; break; case 2: var c = 2; break; }",
    ].join("\n");
    expect(d2044(code)).toEqual(["GM2044@2", "GM2044@3", "GM2044@7"]);
  });
});
function d2044(code: string) {
  return codes(diagnose(GM2044, { [S]: code }));
}

describe("GM2047 unreachable code", () => {
  it("reports the first statement after a terminator", () => {
    const code = [
      "function f() {",
      "  return 1;",
      "  x = 2;",
      "  y = 3;",
      "}",
      "function g() { if (a) { exit; } b = 1; return; }",
      "switch (v) { case 1: break; case 2: c = 1; break; d = 1; }",
      "function h() { return; function inner() {} ;\n#region x\n}",
    ].join("\n");
    expect(codes(diagnose(GM2047, { [S]: code }))).toEqual(["GM2047@3", "GM2047@7"]);
  });
});

describe("GM2061 nullish coalescing", () => {
  it("reports and fixes undefined checks", () => {
    const code = [
      "if (arr == undefined) arr = [];",
      "if (is_undefined(self.v)) { self.v = 1 + 2; }",
      "x = (a == undefined) ? b + 1 : a;",
      "y = !is_undefined(a.b) ? a.b : c;",
      "z = a != undefined ? a : f();",
      "if (arr == undefined) other = [];",
      "w = (f() == undefined) ? 1 : f();",
      "u = a == undefined ? a : b;",
      "if (q == undefined) q = 1; else q = 2;",
    ].join("\n");
    expect(codes(diagnose(GM2061, { [S]: code }))).toEqual(["GM2061@1", "GM2061@2", "GM2061@3", "GM2061@4", "GM2061@5"]);
    expect(fix(GM2061, code).split("\n").slice(0, 5)).toEqual([
      "arr ??= [];",
      "self.v ??= 1 + 2;",
      "x = a ?? (b + 1);",
      "y = a.b ?? c;",
      "z = a ?? f();",
    ]);
  });
});
