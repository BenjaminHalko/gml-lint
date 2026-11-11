/** Minimal glob matcher: `**`, `*`, `?`, `{a,b}`. Paths use forward slashes. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close > i) {
        re += "(?:" + glob.slice(i + 1, close).split(",").map(escape).join("|") + ")";
        i = close + 1;
        continue;
      }
      re += "\\{";
    } else {
      re += escape(c);
    }
    i++;
  }
  return new RegExp("^" + re + "$", "i");
}

function escape(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function matchesAny(path: string, globs: readonly string[] | undefined): boolean {
  if (!globs || globs.length === 0) return false;
  return globs.some((g) => globToRegExp(g).test(path));
}
