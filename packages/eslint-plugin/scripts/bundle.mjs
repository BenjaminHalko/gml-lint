// Bundles dist/ (run `pnpm build` first) and the @gml-lint/* packages into bundle/,
// so the packed tarball only depends on packages from npm.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const out = join(root, "bundle");
const packages = join(root, "..");
const internal = ["parser", "project", "checker"];

rmSync(out, { recursive: true, force: true });

await build({
  entryPoints: [join(root, "dist/index.js")],
  outfile: join(out, "index.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["eslint", "@eslint/*"],
  plugins: [
    {
      // the checker finds its GmlSpec.xml relative to its own file; the copy sits next to the bundle
      name: "spec-path",
      setup(b) {
        b.onLoad({ filter: /[\\/]checker[\\/]dist[\\/]spec[\\/]index\.js$/ }, (args) => {
          const text = readFileSync(args.path, "utf8");
          if (!text.includes('"../../data/GmlSpec.xml"')) throw new Error("GmlSpec.xml path not found in checker");
          return { contents: text.replace('"../../data/GmlSpec.xml"', '"./GmlSpec.xml"'), loader: "js" };
        });
      },
    },
  ],
});
copyFileSync(join(packages, "checker/data/GmlSpec.xml"), join(out, "GmlSpec.xml"));

// Types: the plugin's .d.ts files, plus the internal packages' under bundle/gml-lint/<name>/,
// with "@gml-lint/<name>" imports pointed at those copies.
function copyTypes(from, to) {
  for (const entry of readdirSync(from, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;
    const src = join(entry.parentPath, entry.name);
    const dest = join(to, relative(from, src));
    mkdirSync(dirname(dest), { recursive: true });
    const text = readFileSync(src, "utf8")
      .replace(/^\/\/# sourceMappingURL=.*$/m, "")
      .replace(/(["'])@gml-lint\/(\w+)\1/g, (match, quote, name) => {
        if (!internal.includes(name)) throw new Error(`unknown import ${match} in ${src}`);
        let path = relative(dirname(dest), join(out, "gml-lint", name, "index.js")).replaceAll("\\", "/");
        if (!path.startsWith(".")) path = `./${path}`;
        return quote + path + quote;
      });
    writeFileSync(dest, text);
  }
}
copyTypes(join(root, "dist"), out);
for (const name of internal) copyTypes(join(packages, name, "dist"), join(out, "gml-lint", name));
