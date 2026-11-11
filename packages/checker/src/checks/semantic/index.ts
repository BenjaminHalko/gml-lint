/**
 * Semantic Feather rules: assignments to read-only/constant names, reserved
 * identifiers, deprecations, constructors, member access, object events and
 * local-variable scoping. Like the core checks, they stay silent whenever the
 * checker cannot be sure (unknown `self`, unknown types, dynamic writes).
 */

import type { Check } from "../api.js";
import { GM1008, GM1030, GM1031 } from "./assignment.js";
import { GM2023, GM2039 } from "./calls.js";
import { GM1054, GM1058 } from "./constructors.js";
import { GM1017, GM1023, GM1024 } from "./deprecation.js";
import { GM2016, GM2025, GM2040 } from "./events.js";
import { GM2018, GM2043 } from "./locals.js";
import { GM1012, GM1050, GM1052 } from "./members.js";
import { GM2017 } from "./naming.js";

export { GM1008, GM1012, GM1017, GM1023, GM1024, GM1030, GM1031, GM1050, GM1052, GM1054, GM1058 };
export { GM2016, GM2017, GM2018, GM2023, GM2025, GM2039, GM2040, GM2043 };

export const semanticChecks: Check[] = [
  GM1008, GM1012, GM1017, GM1023, GM1024, GM1030, GM1031, GM1050, GM1052, GM1054, GM1058,
  GM2016, GM2017, GM2018, GM2023, GM2025, GM2039, GM2040, GM2043,
];
