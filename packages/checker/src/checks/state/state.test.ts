import { describe, expect, it } from "vitest";
import { diagnose, testSpec } from "../../testing.js";
import { stateChecks } from "./index.js";

const DRAW = "objects/obj_a/Draw_0.gml";
const codes = (d: Array<{ code: string; line: number }>) => d.map((x) => `${x.code}@${x.line}`);
const run = (code: string, file = DRAW, options: Parameters<typeof diagnose>[2] = {}) =>
  codes(diagnose(stateChecks, { [file]: code }, options));
const lines = (...l: string[]) => l.join("\n");

describe("restore-to-default setters", () => {
  it("reports a set that is never reset (GM2000, GM2063, GM2062, GM2026, GM2019)", () => {
    const code = lines(
      "gpu_set_blendmode(bm_add);",
      "draw_set_alpha(0.5);",
      "draw_set_colour(c_red);",
      "draw_set_halign(fa_center);",
      "draw_set_valign(fa_middle);",
      "draw_self();",
    );
    expect(run(code)).toEqual(["GM2000@1", "GM2063@2", "GM2062@3", "GM2026@4", "GM2019@5"]);
  });
  it("accepts resets with the default value", () => {
    const code = lines(
      "gpu_set_blendmode(bm_add); draw_set_alpha(0.5); draw_set_colour(c_red); draw_set_color(c_red);",
      "draw_set_halign(fa_center); draw_set_valign(fa_middle); gpu_set_fog(true, c_red, 0, 10);",
      "gpu_set_colourwriteenable(true, true, true, false); gpu_set_alphatestref(10); gpu_set_texfilter(true);",
      "draw_self();",
      "gpu_set_blendmode(bm_normal); draw_set_alpha(1.0); draw_set_colour(c_white); draw_set_color($FFFFFF);",
      "draw_set_halign(fa_left); draw_set_valign(fa_top); gpu_set_fog(false, c_black, 0, 1);",
      "gpu_set_colourwriteenable(true, true, true, true); gpu_set_alphatestref(0); gpu_set_texfilter(false);",
    );
    expect(run(code)).toEqual([]);
  });
  it("treats a non-literal argument as dirty, default literals as resets", () => {
    expect(run("draw_set_alpha(a);\ndraw_self();")).toEqual(["GM2063@1"]);
    expect(run("draw_set_alpha(1);\ngpu_set_blendenable(true);\ngpu_set_zfunc(cmpfunc_lessequal);")).toEqual([]);
    expect(run("gpu_set_blendenable(false);\ngpu_set_cullmode(c);\ngpu_set_alphatestenable(true);\ngpu_set_texrepeat(1);")).toEqual([
      "GM2048@1",
      "GM2051@2",
      "GM2053@3",
      "GM2056@4",
    ]);
  });
  it("follows if/else branches", () => {
    const one = lines("draw_set_alpha(0.5);", "if (a) {", "  draw_set_alpha(1);", "}");
    expect(run(one)).toEqual(["GM2063@1"]);
    const both = lines("draw_set_alpha(0.5);", "if (a) draw_set_alpha(1);", "else draw_set_alpha(1);");
    expect(run(both)).toEqual([]);
    const inBranch = lines("if (a) draw_set_alpha(0.5);", "draw_self();", "draw_set_alpha(1);");
    expect(run(inBranch)).toEqual([]);
  });
  it("checks early return/exit and exempts throw", () => {
    const ret = lines("draw_set_alpha(0.5);", "if (a) exit;", "draw_set_alpha(1);");
    expect(run(ret)).toEqual(["GM2063@1"]);
    const thr = lines("draw_set_alpha(0.5);", "if (a) throw \"oops\";", "draw_set_alpha(1);");
    expect(run(thr)).toEqual([]);
    const fnRet = lines("function f() {", "  draw_set_colour(c_red);", "  if (a) return 1;", "  draw_set_colour(c_white);", "  return 0;", "}");
    expect(run(fnRet, "scripts/s/s.gml")).toEqual(["GM2062@2"]);
  });
  it("treats loop bodies as running zero or more times", () => {
    expect(run("repeat (n) draw_set_alpha(0.5);\ndraw_set_alpha(1);")).toEqual([]);
    expect(run("draw_set_alpha(0.5);\nwhile (a) { draw_set_alpha(1); }")).toEqual(["GM2063@1"]);
    expect(run("for (var i = 0; i < 3; i++) { draw_set_alpha(0.5); if (i) break; draw_set_alpha(1); }")).toEqual(["GM2063@1"]);
    expect(run("draw_set_alpha(0.5);\ndo { draw_set_alpha(1); } until (a);")).toEqual([]);
    expect(run("with (obj_a) { draw_set_alpha(0.5); draw_self(); draw_set_alpha(1); }")).toEqual([]);
  });
  it("handles switch with fallthrough and default", () => {
    const fall = lines("switch (k) {", "  case 0: draw_set_alpha(0.5);", "  case 1: draw_set_alpha(1); break;", "  default: draw_set_alpha(1);", "}");
    expect(run(fall)).toEqual([]);
    const brk = lines("switch (k) {", "  case 0: draw_set_alpha(0.5); break;", "  case 1: draw_set_alpha(1); break;", "}", "draw_self();");
    expect(run(brk)).toEqual(["GM2063@2"]);
    const noDefault = lines("draw_set_alpha(0.5);", "switch (k) {", "  case 0: draw_set_alpha(1); break;", "}");
    expect(run(noDefault)).toEqual(["GM2063@1"]);
    const withDefault = lines("draw_set_alpha(0.5);", "switch (k) {", "  case 0: draw_set_alpha(1); break;", "  default: draw_set_alpha(1);", "}");
    expect(run(withDefault)).toEqual([]);
  });
  it("keeps nested functions separate", () => {
    const code = lines(
      "draw_set_alpha(0.5);",
      "var f = function() { draw_set_alpha(1); };",
      "f();",
      "function reset_draw() { draw_set_alpha(1); draw_set_halign(fa_left); }",
      "var g = function() { draw_set_colour(c_red); };",
    );
    expect(run(code, "scripts/s/s.gml")).toEqual(["GM2063@1", "GM2062@5"]);
  });
  it("restores GPU state with gpu_pop_state / gpu_set_state", () => {
    expect(run("gpu_push_state();\ngpu_set_blendmode(bm_add);\ndraw_self();\ngpu_pop_state();")).toEqual([]);
    expect(run("gpu_set_blendmode(bm_add);\ngpu_push_state();\ngpu_pop_state();")).toEqual(["GM2000@1"]);
    expect(run("gpu_set_blendmode(bm_add);\ngpu_set_state(s);", DRAW, { spec: null })).toEqual([]);
    // draw state is not part of the GPU state
    expect(run("gpu_push_state();\ndraw_set_alpha(0.5);\ngpu_pop_state();")).toEqual(["GM2063@2"]);
  });
  it("correlates repeated plain conditions (`if (c) set; ...; if (c) reset;`)", () => {
    const same = lines("if (add) gpu_set_blendmode(bm_add);", "draw_self();", "if (add) { gpu_set_blendmode(bm_normal); }");
    expect(run(same)).toEqual([]);
    const negated = lines("if (darken > 0) shader_set(sh);", "draw_self();", "if (!(darken > 0)) exit;", "shader_reset();");
    expect(run(negated)).toEqual([]);
    const elseBranch = lines("if (!ok) {} else { shader_set(sh); }", "draw_self();", "if (ok) shader_reset();");
    expect(run(elseBranch)).toEqual([]);
    // the variable changes in between: no correlation
    const changed = lines("if (add) gpu_set_blendmode(bm_add);", "add = false;", "if (add) gpu_set_blendmode(bm_normal);");
    expect(run(changed)).toEqual(["GM2000@1"]);
    const declared = lines("if (k) shader_set(sh);", "var k = 1;", "if (k) shader_reset();");
    expect(run(declared)).toEqual(["GM2003@1"]);
    // the branch itself changes the variable
    const inBranch = lines("if (add) { gpu_set_blendmode(bm_add); add = 0; }", "if (add) gpu_set_blendmode(bm_normal);");
    expect(run(inBranch)).toEqual(["GM2000@1"]);
    // conditions with calls are not correlated
    const calls = lines("if (f()) shader_set(sh);", "if (f()) shader_reset();");
    expect(run(calls)).toEqual(["GM2003@1"]);
    // inside `with`, names refer to another instance
    const withs = lines("if (a) shader_set(sh);", "with (obj_a) { if (a) shader_reset(); }", "if (a) shader_reset();");
    expect(run(withs)).toEqual([]);
    const withAssign = lines("if (a) shader_set(sh);", "with (obj_a) { a = 0; }", "if (a) shader_reset();");
    expect(run(withAssign)).toEqual(["GM2003@1"]);
  });
  it("combines conditions with ||, && and !", () => {
    const chain = lines("if (a) shader_set(s1);", "else if (b) shader_set(s2);", "draw_self();", "if (a || b) shader_reset();");
    expect(run(chain)).toEqual([]);
    expect(run("if (a && b) shader_set(sh);\nif (a && b) shader_reset();")).toEqual([]);
    expect(run("if (a and b) shader_set(sh);\nif (!a) exit;\nif (b) shader_reset();")).toEqual([]);
    expect(run("if (a) shader_set(sh);\nif (b) shader_reset();")).toEqual(["GM2003@1"]);
    expect(run("if (a || b) shader_set(sh);\nif (a) shader_reset();")).toEqual(["GM2003@1"]);
  });
  it("accepts restoring a value saved from the matching getter", () => {
    const spec = testSpec(
      `<GameMakerLanguageSpec RuntimeVersion="test" Module="Extra"><Functions>` +
        ["draw_get_alpha", "draw_get_halign", "draw_get_valign", "gpu_get_texfilter"]
          .map((n) => `<Function Name="${n}" Deprecated="false" ReturnType="Real" Pure="false"></Function>`)
          .join("") +
        `</Functions></GameMakerLanguageSpec>`,
    );
    const code = lines(
      "function text(_align) {",
      "  var _h = draw_get_halign(), _v = draw_get_valign();",
      "  draw_set_halign(_align[0]);",
      "  draw_set_valign(_align[1]);",
      "  draw_self();",
      "  draw_set_halign(_h);",
      "  draw_set_valign(_v);",
      "}",
      "var _f = gpu_get_texfilter();",
      "gpu_set_texfilter(true);",
      "gpu_set_texfilter(_f);",
      "prev = draw_get_alpha();",
      "draw_set_alpha(0.5);",
      "draw_set_alpha(prev);",
      "draw_set_alpha(other_value);",
    );
    expect(run(code, "scripts/s/s.gml", { spec })).toEqual(["GM2063@15"]);
  });
  it("supports allowInEvents", () => {
    const code = "draw_set_alpha(0.5);\ndraw_set_halign(fa_center);";
    const options = { GM2063: { allowInEvents: ["draw begin"] } };
    expect(codes(diagnose(stateChecks, { "objects/obj_a/Draw_72.gml": code }, { options }))).toEqual(["GM2026@2"]);
    expect(codes(diagnose(stateChecks, { "objects/obj_a/Draw_0.gml": code }, { options }))).toEqual(["GM2063@1", "GM2026@2"]);
  });
  it("ignores user functions with the same name", () => {
    expect(run("function draw_set_alpha_x() {}\nvar draw_set_alpha = function(a) {};\ndraw_set_alpha(0.5);", "scripts/s/s.gml")).toEqual([]);
  });
});

describe("open/close pairs", () => {
  it("GM2003 shader_set without shader_reset on some path", () => {
    expect(run("shader_set(sh);\nif (a) shader_reset();")).toEqual(["GM2003@1"]);
    expect(run("shader_set(sh);\ndraw_self();\nshader_reset();")).toEqual([]);
    expect(run("if (!ok) return;\nshader_set(sh);\nif (b) { shader_reset(); return; }\ndraw_self();\nshader_reset();")).toEqual([]);
    expect(run("shader_set(sh);\nif (b) return;\nshader_reset();")).toEqual(["GM2003@1"]);
  });
  it("GM2005/GM2046 surface targets", () => {
    expect(run("surface_set_target(s);\ndraw_self();")).toEqual(["GM2005@1"]);
    expect(run("surface_set_target(s);\nsurface_set_target(t);\nsurface_reset_target();\nsurface_reset_target();")).toEqual([]);
    expect(run("surface_set_target(s);\nsurface_set_target(t);\nsurface_reset_target();")).toEqual(["GM2005@1"]);
    const branchy = lines("if (a) surface_set_target(s);", "draw_self();", "if (a) surface_reset_target();");
    expect(run(branchy)).toEqual(["GM2046@1"]); // the second `if (a)` follows the first
  });
  it("GM2035/GM2042 gpu push/pop depth", () => {
    const docExample = lines("gpu_push_state();", "gpu_set_blendmode(bm_add);", "if (show_name) {", "  draw_self();", "  gpu_pop_state();", "}");
    expect(run(docExample)).toEqual(["GM2035@1", "GM2000@2", "GM2042@3"]);
    expect(run("gpu_push_state();\ngpu_push_state();\ngpu_pop_state();")).toEqual(["GM2035@1"]);
    expect(run("gpu_push_state();\ngpu_push_state();\ngpu_pop_state();\ngpu_pop_state();")).toEqual([]);
    // pop without a push here: pushed by other code, not reported
    expect(run("gpu_pop_state();")).toEqual([]);
    // innermost inconsistent construct only
    const nested = lines("if (a) {", "  if (b) gpu_push_state();", "}", "gpu_pop_state();");
    expect(run(nested)).toEqual(["GM2042@2"]);
    expect(run("repeat (n) gpu_push_state();\nrepeat (n) gpu_pop_state();")).toEqual(["GM2042@1", "GM2035@1", "GM2042@2"]);
  });
  it("vertex batches GM2008/GM2009/GM2010/GM2011", () => {
    const ok = lines("vertex_begin(vb, fmt);", "vertex_position(vb, 0, 0);", "vertex_end(vb);");
    expect(run(ok)).toEqual([]);
    const nested = lines("vertex_begin(vb, fmt);", "vertex_begin(vb, fmt);", "vertex_end(vb);");
    expect(run(nested)).toEqual(["GM2008@2"]);
    const outside = lines("vertex_begin(vb, fmt);", "vertex_end(vb);", "vertex_position(vb, 0, 0);", "vertex_end(vb);");
    expect(run(outside)).toEqual(["GM2010@3", "GM2009@4"]);
    expect(run("vertex_begin(vb, fmt);\nvertex_position(vb, 0, 0);")).toEqual(["GM2011@1"]);
    // only report "outside" when definitely outside on all paths
    expect(run("if (a) vertex_begin(vb, fmt);\nvertex_position(vb, 0, 0);\nif (b) vertex_end(vb);")).toEqual(["GM2011@1"]);
    // batches are per buffer: building two buffers at once is fine
    const two = lines("vertex_begin(vb_a, fmt);", "vertex_begin(vb_b, fmt);", "vertex_position(vb_a, 0, 0);", "vertex_end(vb_a);", "vertex_end(vb_b);");
    expect(run(two)).toEqual([]);
    expect(run("vertex_begin(vb_a, fmt);\nvertex_begin(vb_b, fmt);\nvertex_end(vb_a);")).toEqual(["GM2011@2"]);
    // helpers that write vertices for their caller are fine
    expect(run("function quad(vb) { vertex_position(vb, 0, 0); vertex_end(vb); }", "scripts/s/s.gml")).toEqual([]);
  });
  it("vertex formats GM2012/GM2013/GM2014/GM2015", () => {
    expect(run("vertex_format_begin();\nvertex_format_add_position();\nf = vertex_format_end();", "objects/obj_a/Create_0.gml")).toEqual([]);
    const bad = lines("vertex_format_begin();", "vertex_format_begin();", "f = vertex_format_end();", "vertex_format_add_position();", "g = vertex_format_end();");
    expect(run(bad, "objects/obj_a/Create_0.gml")).toEqual(["GM2012@2", "GM2014@4", "GM2013@5"]);
    expect(run("vertex_format_begin();\nvertex_format_add_position();", "objects/obj_a/Create_0.gml")).toEqual(["GM2015@1"]);
  });
  it("primitives GM2027/GM2028/GM2029/GM2030", () => {
    const docExample = lines("var c = irandom(100) < 50;", "draw_primitive_begin(pr_trianglelist);", "if (c) {", "  draw_vertex(0, 0);", "  draw_primitive_end();", "}");
    expect(run(docExample)).toEqual(["GM2030@2"]);
    const bad = lines("draw_vertex(0, 0);", "draw_primitive_begin(pr_trianglelist);", "draw_primitive_begin(pr_trianglelist);", "draw_primitive_end();", "draw_primitive_end();");
    expect(run(bad)).toEqual(["GM2029@1", "GM2027@3", "GM2028@5"]);
  });
  it("iterates loops: a close reached on later iterations is not 'unopened'", () => {
    const code = lines(
      "var cur = -1;",
      "for (var j = 0; j < n; j++) {",
      "  if (tex[j] != cur) {",
      "    if (cur != -1) draw_primitive_end();",
      "    draw_primitive_begin(pr_trianglelist);",
      "    cur = tex[j];",
      "  }",
      "  draw_vertex(0, 0);",
      "}",
      "draw_primitive_end();",
    );
    expect(run(code)).toEqual([]);
  });
  it("file find GM2031/GM2032/GM2033/GM2034", () => {
    const ok = lines("var f = file_find_first(\"*.txt\", fa_archive);", "while (f != \"\") { f = file_find_next(); }", "file_find_close();");
    expect(run(ok, "scripts/s/s.gml")).toEqual([]);
    const docExample = lines("var f = file_find_first(\"*.txt\", fa_archive);", "while (f != \"\") { f = file_find_next(); }");
    expect(run(docExample, "scripts/s/s.gml")).toEqual(["GM2034@1"]);
    const bad = lines("var f = file_find_first(\"a\", 0);", "if (b) { var g = file_find_first(\"b\", 0); }", "file_find_close();", "file_find_next();", "file_find_close();");
    expect(run(bad, "scripts/s/s.gml")).toEqual(["GM2031@2", "GM2033@4", "GM2032@5"]);
  });
  it("works without a spec (bare names)", () => {
    expect(run("shader_set(sh);\ndraw_set_alpha(0.5);", DRAW, { spec: null })).toEqual(["GM2003@1", "GM2063@2"]);
  });
  it("handles try/catch and logical expressions", () => {
    expect(run("try { shader_set(sh); draw_self(); } catch (e) {} finally { shader_reset(); }")).toEqual([]);
    expect(run("ok = a && surface_set_target(s);\ndraw_self();\nif (ok) surface_reset_target();")).toEqual(["GM2005@1", "GM2046@3"]);
  });
});
