import {
  allChecks,
  applyFixes,
  loadSpec,
  Program,
  runChecks,
  type Check,
  type Diagnostic,
  type GmlintConfig,
  type GmlSpec,
  type Preset,
  type RuleSetting,
  type SeveritySetting,
} from "@gml-lint/checker";
import { loadProject, type Project } from "@gml-lint/project";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "./config-file.js";
import { formatters, summarize, type FormatContext } from "./formatters.js";

export { formatters } from "./formatters.js";
export { loadConfig, parseJsonc } from "./config-file.js";

const PRESETS: readonly Preset[] = ["syntax", "recommended", "strict", "all"];

function toolVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string }).version;
}

const HELP = `gmlc ${toolVersion()}

Usage:
  gmlc [project]               Check a project (.yyp or its folder; default: current folder)
  gmlc rules [--format json]   List checks

Options:
  --preset <name>              syntax | recommended (default) | strict | all
  --rule <code>=<severity>     Override a check, e.g. --rule GM2017=off (repeatable)
  --config <file>              Config file (default: gmlint.config.json next to the project)
  --format <name>              pretty (default) | compact | json | github
  --fix                        Apply automatic fixes
  --quiet                      Report errors only
  --max-warnings <n>           Exit with 1 when there are more warnings than this
  --spec <file>                Use this GmlSpec.xml instead of the bundled one
  --no-color
  -h, --help, -v, --version
`;

function fail(message: string): number {
  console.error(`gmlc: ${message}`);
  return 2;
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        preset: { type: "string" },
        rule: { type: "string", multiple: true },
        config: { type: "string" },
        format: { type: "string" },
        fix: { type: "boolean" },
        quiet: { type: "boolean" },
        "max-warnings": { type: "string" },
        spec: { type: "string" },
        "no-color": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    return fail(`${(err as Error).message}\n\n${HELP}`);
  }
  const { values: opts, positionals } = parsed;
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    console.log(toolVersion());
    return 0;
  }
  if (positionals[0] === "rules") return listRules(opts.format);

  let project: Project;
  let spec: GmlSpec;
  let config: GmlintConfig;
  let checks: Check[];
  try {
    project = loadProject(resolve(positionals[0] ?? process.cwd()));
    spec = loadSpec(opts.spec);
    const loaded = loadConfig(opts.config, project.dir);
    config = loaded.config;
    checks = [...allChecks, ...(await loadPlugins(config.plugins ?? [], loaded.path ? dirname(loaded.path) : project.dir))];
  } catch (err) {
    return fail((err as Error).message);
  }

  if (opts.preset) {
    if (!PRESETS.includes(opts.preset as Preset)) return fail(`unknown preset '${opts.preset}' (expected ${PRESETS.join(", ")})`);
    config = { ...config, preset: opts.preset as Preset };
  }
  if (opts.rule?.length) {
    const rules: Record<string, RuleSetting> = { ...config.rules };
    for (const r of opts.rule) {
      const m = /^([^=]+)=(off|error|warning|warn|suggestion)$/.exec(r);
      if (!m || !checks.some((c) => c.meta.code === m[1]!.toUpperCase() || c.meta.name === m[1]!.replace(/^gml\//, ""))) return fail(`invalid --rule '${r}' (expected <code>=off|error|warning|suggestion)`);
      rules[m[1]!] = (m[2] === "warn" ? "warning" : m[2]) as SeveritySetting;
    }
    config = { ...config, rules };
  }

  const formatName = opts.format ?? "pretty";
  const formatter = formatters[formatName];
  if (!formatter) return fail(`unknown format '${formatName}' (expected ${Object.keys(formatters).join(", ")})`);

  const program = new Program({ project, spec });
  let result = runChecks(program, { checks, config });
  if (opts.fix) result = fixAll(program, checks, config, result.diagnostics) ?? result;

  const diagnostics = opts.quiet ? result.diagnostics.filter((d) => d.severity === "error") : result.diagnostics;
  const ctx: FormatContext = {
    projectDir: project.dir,
    projectName: project.name,
    toolVersion: toolVersion(),
    filesChecked: result.filesChecked,
    color: !opts["no-color"] && process.stdout.isTTY === true && !process.env["NO_COLOR"],
  };
  process.stdout.write(formatter(diagnostics, ctx));

  const s = summarize(diagnostics);
  if (s.error > 0) return 1;
  const max = opts["max-warnings"] !== undefined ? Number(opts["max-warnings"]) : Infinity;
  return s.warning > max ? 1 : 0;
}

/** Applies fixes and re-checks until nothing changes (at most 10 passes). */
function fixAll(program: Program, checks: Check[], config: GmlintConfig, diagnostics: Diagnostic[]): ReturnType<typeof runChecks> | null {
  let result: ReturnType<typeof runChecks> | null = null;
  for (let pass = 0; pass < 10; pass++) {
    const byFile = new Map<string, Diagnostic[]>();
    for (const d of diagnostics) {
      if (!d.fix) continue;
      const list = byFile.get(d.file) ?? [];
      list.push(d);
      byFile.set(d.file, list);
    }
    let applied = 0;
    for (const [file, list] of byFile) {
      const source = program.getSourceFile(file);
      if (!source) continue;
      const r = applyFixes(source.text, list);
      if (r.applied === 0) continue;
      writeFileSync(file, source.text.includes("\r\n") ? r.text.replace(/\r?\n/g, "\r\n") : r.text, "utf8");
      program.updateFile(file, r.text);
      applied += r.applied;
    }
    if (applied === 0) break;
    result = runChecks(program, { checks, config });
    diagnostics = result.diagnostics;
  }
  return result;
}

/**
 * Loads project checks. A plugin module exports ProjectChecks (objects with
 * `meta` and `create`) as its default export or as named exports, singly or in arrays.
 */
async function loadPlugins(paths: string[], baseDir: string): Promise<Check[]> {
  const seen = new Set<Check>();
  const out: Check[] = [];
  for (const p of paths) {
    const mod = (await import(pathToFileURL(resolve(baseDir, p)).href)) as Record<string, unknown>;
    const found = Object.values(mod).flatMap((v) => (Array.isArray(v) ? v : [v])).filter(isCheck);
    if (found.length === 0) throw new Error(`plugin ${p} exports no checks`);
    for (const c of found) {
      if (seen.has(c)) continue;
      seen.add(c);
      const defaults = { description: c.meta.name, category: "semantic", defaultSeverity: "warning", preset: "recommended", feather: false } as const;
      out.push({ ...c, meta: { ...defaults, ...c.meta } });
    }
  }
  return out;
}

function isCheck(v: unknown): v is Check {
  const c = v as Partial<Check> | null;
  return !!c && typeof c.create === "function" && typeof c.meta?.code === "string" && typeof c.meta.name === "string";
}

function listRules(format: string | undefined): number {
  const rows = allChecks.map((c) => c.meta);
  if (format === "json") {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return 0;
  }
  for (const m of rows) {
    console.log(`${m.code.padEnd(7)} ${m.name.padEnd(40)} ${m.defaultSeverity.padEnd(10)} ${m.preset.padEnd(11)} ${m.description}`);
  }
  return 0;
}
