import { describe, expect, it } from "vitest";
import type * as AST from "@gml-lint/parser";
import { createTestProgram, testSpec } from "../../testing.js";
import { typeToString } from "../../types.js";

/** Type of the initialiser of `var <name> = ...` in a one-file script project. */
function typeOfVar(code: string, name: string, extraSpec?: string): string {
  const program = createTestProgram({ "scripts/s/s.gml": code }, extraSpec ? { spec: testSpec(extraSpec) } : {});
  const file = program.getSourceFiles()[0]!;
  const fc = program.getChecker().forFile(file);
  for (const st of file.ast.body) {
    if (st.type !== "VariableDeclaration") continue;
    for (const d of st.declarations) if (d.id.name === name && d.init) return typeToString(fc.typeOf(d.init as AST.Expression));
  }
  throw new Error(`no var ${name}`);
}

describe("inference improvements used by the type checks", () => {
  it("types `+` with string unions as concatenation", () => {
    expect(typeOfVar('function f() { if (c) return "a"; }\nvar a = "x" + f() + "y";', "a")).toBe("String");
    expect(typeOfVar("var u = choose(1, \"s\");\nvar b = u + 1;", "b")).toBe("Real | String");
    expect(typeOfVar("var c = 1 + 2;", "c")).toBe("Real");
  });
  it("types ArgumentIdentity returns from ArgumentIdentity parameters or array elements only", () => {
    const extra =
      `<GameMakerLanguageSpec><Functions>` +
      `<Function Name="ds_list_find_value" ReturnType="ArgumentIdentity"><Parameter Name="id" Type="Id.DsList" Optional="false"/><Parameter Name="pos" Type="Real" Optional="false"/></Function>` +
      `<Function Name="array_pop" ReturnType="ArgumentIdentity"><Parameter Name="array" Type="Array" Optional="false"/></Function>` +
      `<Function Name="array_create_ai" ReturnType="Array[ArgumentIdentity]"><Parameter Name="size" Type="Real" Optional="false"/><Parameter Name="value" Type="ArgumentIdentity" Optional="true"/></Function>` +
      `</Functions></GameMakerLanguageSpec>`;
    expect(typeOfVar("var l = ds_list_create();\nvar v = ds_list_find_value(l, 0);", "v", extra)).toBe("Unknown");
    expect(typeOfVar('var v = choose(1, "a");', "v", extra)).toBe("Real | String");
    expect(typeOfVar('var v = array_pop(["a"]);', "v", extra)).toBe("String");
    expect(typeOfVar("var v = array_create_ai(3, 0);", "v", extra)).toBe("Array<Real>");
  });
  it("shares one lazily-typed signature per function", () => {
    const program = createTestProgram({ "scripts/s/s.gml": "function f() { return 1; }\nvar a = f;\nvar b = f;" });
    const file = program.getSourceFiles()[0]!;
    const fc = program.getChecker().forFile(file);
    const decls = file.ast.body.filter((s): s is AST.VariableDeclaration => s.type === "VariableDeclaration");
    const [ta, tb] = decls.map((d) => fc.typeOf(d.declarations[0]!.init!));
    expect(ta!.kind === "function" && tb!.kind === "function" && ta!.signature === tb!.signature).toBe(true);
    expect(ta!.kind === "function" && typeToString(ta!.signature!.returnType)).toBe("Real");
  });
});
