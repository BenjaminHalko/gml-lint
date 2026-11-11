import { configRules } from "./configs.js";
import { gmlLanguage } from "./language.js";
import { rules, ruleIdsByCode } from "./rules.js";

export { assetFolderIgnores } from "./ignores.js";
export { GmlLanguage, GmlSourceCode, gmlLanguage } from "./language.js";
export type { GmlParserServices } from "./language.js";
export { getParserServices, checkToRule, rules, ruleIdsByCode } from "./rules.js";
export type { GmlRule } from "./rules.js";
export { clearPrograms } from "./programs.js";
export type { GmlLanguageOptions } from "./programs.js";

type ConfigName = keyof typeof configRules;

interface FlatConfig {
  name: string;
  files: string[];
  plugins: Record<string, unknown>;
  language: string;
  languageOptions: Record<string, unknown>;
  rules: Record<string, "warn" | "error">;
}

const plugin = {
  meta: { name: "eslint-plugin-gml", version: "0.1.0", namespace: "gml" },
  languages: { gml: gmlLanguage },
  rules,
  configs: {} as Record<ConfigName, FlatConfig>,
  ruleIdsByCode,
};

for (const name of Object.keys(configRules) as ConfigName[]) {
  plugin.configs[name] = {
    name: `gml/${name}`,
    files: ["**/*.gml"],
    plugins: { gml: plugin },
    language: "gml/gml",
    languageOptions: { project: "auto" },
    rules: configRules[name],
  };
}

export default plugin;
