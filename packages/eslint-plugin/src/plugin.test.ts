import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import gml, { getParserServices } from "./index.js";

function lint(code: string, rules: Record<string, unknown>, extra: object[] = []) {
  const linter = new Linter({ configType: "flat" });
  return linter.verify(
    code,
    [
      {
        files: ["**/*.gml"],
        plugins: { gml: gml as never },
        language: "gml/gml",
        languageOptions: { project: false },
        rules: rules as never,
      },
      ...(extra as never[]),
    ],
    { filename: "test.gml" },
  );
}

describe("eslint-plugin-gml", () => {
  it("exposes configs and rules", () => {
    expect(gml.configs.recommended.rules["gml/no-break-outside-loop"]).toBe("error");
    expect(Object.keys(gml.rules)).toContain("syntax-error");
    expect(gml.ruleIdsByCode["GM1000"]).toBe("gml/no-break-outside-loop");
  });

  it("reports checks through ESLint with locations", () => {
    const messages = lint("a = 1;\nbreak;", { "gml/no-break-outside-loop": "error" });
    expect(messages.map((m) => [m.ruleId, m.line, m.column, m.message])).toEqual([
      ["gml/no-break-outside-loop", 2, 1, "No enclosing loop from which to break."],
    ]);
  });

  it("reports syntax errors via gml/syntax-error", () => {
    const messages = lint("a = ;", { "gml/syntax-error": "error" });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.ruleId).toBe("gml/syntax-error");
  });

  it("honours eslint-disable comments and Feather directives", () => {
    const rules = { "gml/no-break-outside-loop": "error", "gml/no-continue-outside-loop": "error" };
    expect(lint("// eslint-disable-next-line gml/no-break-outside-loop\nbreak;", rules)).toEqual([]);
    expect(lint("// Feather disable GM1001\ncontinue;", rules)).toEqual([]);
  });

  it("supports custom rules using the checker", () => {
    const custom = {
      meta: { type: "problem", schema: [] },
      create(context: never) {
        const { fc } = getParserServices(context);
        return {
          CallExpression(node: { callee: { type: string; name?: string } }) {
            if (node.callee.type === "Identifier") {
              const r = fc.resolve(node.callee as never);
              if (r?.kind === "global-function") (context as { report(d: object): void }).report({ node, message: `calls ${node.callee.name}` });
            }
          },
        };
      },
    };
    const messages = lint(
      "function helper() {}\nhelper();",
      { "local/calls": "error" },
      [{ files: ["**/*.gml"], plugins: { local: { rules: { calls: custom } } } }],
    );
    // Standalone files have no project, so `helper` is not a global script function.
    expect(messages).toEqual([]);
  });
});
