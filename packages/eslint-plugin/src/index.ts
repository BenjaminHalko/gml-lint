import { allChecks, presetIncludes, type Preset } from "@gml-lint/checker";
import { gmlLanguage } from "./language.js";
import { rules, ruleIdsByCode } from "./rules.js";

export { GmlLanguage, GmlSourceCode, gmlLanguage } from "./language.js";
export type { GmlParserServices } from "./language.js";
export { getParserServices, checkToRule, rules, ruleIdsByCode } from "./rules.js";
export type { GmlRule } from "./rules.js";
export { clearPrograms } from "./programs.js";
export type { GmlLanguageOptions } from "./programs.js";

const VERSION = "0.1.0";

type RuleLevel = "error" | "warn";

function rulesFor(preset: Preset): Record<string, RuleLevel> {
  const out: Record<string, RuleLevel> = {};
  for (const c of allChecks) {
    if (!presetIncludes(preset, c.meta.preset)) continue;
    out[`gml/${c.meta.name}`] = c.meta.defaultSeverity === "error" ? "error" : "warn";
  }
  return out;
}

interface FlatConfig {
  name: string;
  files: string[];
  plugins: Record<string, unknown>;
  language: string;
  languageOptions: Record<string, unknown>;
  rules: Record<string, RuleLevel>;
}

const plugin = {
  meta: { name: "eslint-plugin-gml", version: VERSION, namespace: "gml" },
  languages: { gml: gmlLanguage },
  rules,
  configs: {} as Record<Preset, FlatConfig>,
  ruleIdsByCode,
};

for (const preset of ["syntax", "recommended", "strict", "all"] as const) {
  plugin.configs[preset] = {
    name: `gml/${preset}`,
    files: ["**/*.gml"],
    plugins: { gml: plugin },
    language: "gml/gml",
    languageOptions: { project: "auto" },
    rules: rulesFor(preset),
  };
}

export default plugin;
