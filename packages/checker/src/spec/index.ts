/**
 * GameMaker's built-in API (functions, variables, constants, structures,
 * enumerations) from GmlSpec.xml. The bundled copy is `data/GmlSpec.xml`.
 */

import { fileURLToPath } from "node:url";
import { loadSpecFiles } from "./load.js";
import type { GmlSpec } from "./types.js";

export type * from "./types.js";
export { createEmptySpec, loadSpecFiles, parseSpecXml } from "./load.js";
export { parseXml, XmlParseError } from "./xml.js";
export type { XmlElement } from "./xml.js";

/** Same path from `src/spec/` and `dist/spec/`. */
export const BUNDLED_SPEC_PATH = fileURLToPath(new URL("../../data/GmlSpec.xml", import.meta.url));

let bundled: GmlSpec | null = null;

/** Loads the given GmlSpec.xml file(s), or the bundled one (cached) when none are given. */
export function loadSpec(paths?: string | string[]): GmlSpec {
  if (paths !== undefined) return loadSpecFiles(paths);
  bundled ??= loadSpecFiles(BUNDLED_SPEC_PATH);
  return bundled;
}
