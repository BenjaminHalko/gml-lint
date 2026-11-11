import type { GmlintConfig } from "@gml-lint/checker";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const CONFIG_FILE_NAMES = ["gmlint.config.json", ".gmlintrc.json", ".gmlintrc"];

/** Strips // and /* *\/ comments and trailing commas outside strings (JSONC). */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export interface LoadedConfig {
  config: GmlintConfig;
  path: string | null;
}

/** Finds a config next to the project, walking up to the filesystem root. */
export function findConfig(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    for (const name of CONFIG_FILE_NAMES) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig(explicit: string | undefined, projectDir: string): LoadedConfig {
  const path = explicit ? resolve(explicit) : findConfig(projectDir);
  if (!path) return { config: {}, path: null };
  const raw = parseJsonc(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path}: config must be a JSON object`);
  return { config: raw as GmlintConfig, path };
}
