/**
 * Feather syntax and style rules: malformed statements, declarations the
 * compiler rejects or that are likely mistakes, and simple rewrites.
 */

import type { Check } from "../api.js";
import { declarationChecks } from "./declarations.js";
import { statementChecks } from "./statements.js";
import { styleChecks } from "./style.js";

export { GM1002, GM1003, GM1004, GM1006, GM1032, GM1034, GM1036, GM1038, GM1040, GM1051, GM1055, GM1056, GM1059, GM1064 } from "./declarations.js";
export { GM1007, GM1015, GM1016, GM1022, GM1025, GM1026, GM1027, GM1033, GM2007, GM2020, GM2044, GM2047 } from "./statements.js";
export { GM2004, GM2061 } from "./style.js";

export const syntaxChecks: Check[] = [...declarationChecks, ...statementChecks, ...styleChecks].sort((a, b) =>
  a.meta.code.localeCompare(b.meta.code),
);
