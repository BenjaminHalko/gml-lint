import type { Check } from "./api.js";
import { coreChecks } from "./core/index.js";
import { syntaxChecks } from "./syntax/index.js";
import { semanticChecks } from "./semantic/index.js";
import { stateChecks } from "./state/index.js";
import { typeChecks } from "./types/index.js";

export * from "./api.js";
export { Suppressions } from "./directives.js";
export { globToRegExp } from "./glob.js";
export type { FeatherProfile, SuppressionOptions } from "./directives.js";
export { applyFixes, makeContext, PARSE_ERROR_CODE, runChecks } from "./runner.js";
export type { RunOptions } from "./runner.js";
export * as checkUtil from "./util.js";
export { coreChecks, semanticChecks, stateChecks, syntaxChecks, typeChecks };

/** Every built-in check, sorted by code. */
export const allChecks: readonly Check[] = [...coreChecks, ...syntaxChecks, ...semanticChecks, ...stateChecks, ...typeChecks].sort((a, b) =>
  a.meta.code.localeCompare(b.meta.code),
);

export function findCheck(codeOrName: string): Check | undefined {
  const key = codeOrName.replace(/^gml\//, "");
  return allChecks.find((c) => c.meta.code === key.toUpperCase() || c.meta.name === key);
}
