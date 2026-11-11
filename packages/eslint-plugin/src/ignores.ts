import { globToRegExp } from "@gml-lint/checker";
import { loadProject } from "@gml-lint/project";
import { relative, resolve } from "node:path";

/**
 * ESLint `ignores` patterns for the GML files of resources in Asset Browser
 * folders, e.g. `assetFolderIgnores("Game", ["Extensions/**"])`. Paths are
 * relative to `baseDir` (default: the working directory, ESLint's base path
 * when the config is in the working directory).
 */
export function assetFolderIgnores(project: string, folders: string[], baseDir = process.cwd()): string[] {
  const p = loadProject(resolve(baseDir, project));
  const patterns = folders.map((f) => globToRegExp(f));
  const out: string[] = [];
  for (const file of p.gmlFiles) {
    const res = p.resources.get(file.owner);
    const assetPath = `${res?.folder ? res.folder + "/" : ""}${file.owner}`;
    if (patterns.some((re) => re.test(assetPath))) out.push(relative(baseDir, file.path).replace(/\\/g, "/"));
  }
  return out;
}
