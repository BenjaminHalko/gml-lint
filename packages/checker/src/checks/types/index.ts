/**
 * Type checks: Feather's type rules, including its Strict Type mode (preset
 * "strict"). All of them stay silent unless every type involved is definite.
 */

import type { Check } from "../api.js";
import { GM1029, GM1041, GM1044, GM1060 } from "./calls.js";
import { GM1035, GM1042, GM1043, GM1045, GM1062 } from "./functions.js";
import { GM1009, GM1010, GM1011, GM1028, GM1063 } from "./operations.js";

export { GM1009, GM1010, GM1011, GM1028, GM1029, GM1035, GM1041, GM1042, GM1043, GM1044, GM1045, GM1060, GM1062, GM1063 };

export const typeChecks: Check[] = [
  GM1009, GM1010, GM1011, GM1028, GM1029, GM1035, GM1041, GM1042, GM1043, GM1044, GM1045, GM1060, GM1062, GM1063,
];
