import { globToRegExp } from "@gml-lint/checker";
import { loadProject } from "@gml-lint/project";
import { dirname, relative, resolve } from "node:path";

/**
 * ESLint `ignores` patterns for the resources in Asset Browser folders, e.g.
 * `assetFolderIgnores("Game", ["Extensions/**"])`. Paths are relative to
 * `baseDir` (default: the working directory).
 *
 * Resources are matched by name prefix where possible (`scripts/Vinyl*`),
 * because ESLint tests every file against every pattern and a pattern per
 * file is slow on large projects.
 */
export function assetFolderIgnores(project: string, folders: string[], baseDir = process.cwd()): string[] {
  const p = loadProject(resolve(baseDir, project));
  const patterns = folders.map((f) => globToRegExp(f));

  // Resource directories (objects/obj_x, scripts/scr_x, ...) grouped by parent directory
  const byParent = new Map<string, Map<string, boolean>>();
  for (const file of p.gmlFiles) {
    if (file.kind === "instance-creation" || file.kind === "room-creation") continue; // rooms hold other rooms' code
    const res = p.resources.get(file.owner);
    const ignored = patterns.some((re) => re.test(`${res?.folder ? res.folder + "/" : ""}${file.owner}`));
    const dir = relative(baseDir, dirname(file.path)).replace(/\\/g, "/");
    const parent = dirname(dir);
    const names = byParent.get(parent) ?? new Map<string, boolean>();
    names.set(dir.slice(parent.length + 1), ignored);
    byParent.set(parent, names);
  }

  const out: string[] = [];
  for (const [parent, names] of byParent) {
    const kept = [...names].filter(([, ignored]) => !ignored).map(([n]) => n.toLowerCase());
    const covered: string[] = [];
    for (const name of [...names].filter(([, ignored]) => ignored).map(([n]) => n).sort()) {
      if (covered.some((prefix) => name.startsWith(prefix))) continue;
      // Shortest prefix that no kept resource starts with
      let len = 1;
      while (len < name.length && kept.some((k) => k.startsWith(name.slice(0, len).toLowerCase()))) len++;
      const prefix = len < name.length ? name.slice(0, len) : name;
      covered.push(prefix);
      out.push(prefix === name ? `${parent}/${name}/**` : `${parent}/${prefix}*/**`);
    }
  }
  return out;
}
