import type { Check, Preset, Severity, SeveritySetting } from "./api.js";
import { matchesAny } from "./glob.js";

export type RuleSetting = SeveritySetting | [SeveritySetting] | [SeveritySetting, Record<string, unknown>];

export interface ConfigOverride {
  /** Globs matched against project-relative paths, or `folder:Scripts/Libraries/**` against Asset Browser folders. */
  files: string[];
  preset?: Preset;
  rules?: Record<string, RuleSetting>;
}

export interface GmlintConfig {
  /** Default: "recommended". */
  preset?: Preset;
  /** Keyed by code (GM2017) or name (naming-convention). */
  rules?: Record<string, RuleSetting>;
  /** Files to skip entirely (same pattern syntax as overrides). */
  ignore?: string[];
  overrides?: ConfigOverride[];
  /** Honour `// Feather ...` directives (default true). */
  featherDirectives?: boolean;
  /** Modules with project-specific checks, relative to the config file. */
  plugins?: string[];
}

const PRESET_ORDER: readonly Preset[] = ["syntax", "recommended", "strict", "all"];

export function presetIncludes(active: Preset, required: Preset): boolean {
  return PRESET_ORDER.indexOf(required) <= PRESET_ORDER.indexOf(active);
}

export interface EnabledCheck {
  check: Check;
  severity: Severity;
  options: Record<string, unknown>;
}

function normalizeSetting(s: RuleSetting): { severity: SeveritySetting; options: Record<string, unknown> } {
  if (Array.isArray(s)) return { severity: s[0], options: (s[1] as Record<string, unknown> | undefined) ?? {} };
  return { severity: s, options: {} };
}

function settingFor(rules: Record<string, RuleSetting> | undefined, check: Check): RuleSetting | undefined {
  if (!rules) return undefined;
  return rules[check.meta.code] ?? rules[check.meta.name] ?? rules[`gml/${check.meta.name}`];
}

/** Path forms a pattern may match: the relative path, and `folder:<asset folder>/<resource>`. */
export interface FileIdentity {
  relativePath: string;
  folderPath: string | null;
}

export function matchesFile(patterns: readonly string[] | undefined, id: FileIdentity): boolean {
  if (!patterns || patterns.length === 0) return false;
  const pathGlobs = patterns.filter((p) => !p.startsWith("folder:"));
  const folderGlobs = patterns.filter((p) => p.startsWith("folder:")).map((p) => p.slice("folder:".length));
  if (matchesAny(id.relativePath, pathGlobs)) return true;
  return id.folderPath !== null && matchesAny(id.folderPath, folderGlobs);
}

/** Resolves which checks run on a file, and at what severity. */
export function enabledChecks(checks: readonly Check[], config: GmlintConfig, id: FileIdentity): EnabledCheck[] {
  let preset = config.preset ?? "recommended";
  const ruleLayers: Array<Record<string, RuleSetting> | undefined> = [config.rules];
  for (const o of config.overrides ?? []) {
    if (matchesFile(o.files, id)) {
      if (o.preset) preset = o.preset;
      ruleLayers.push(o.rules);
    }
  }
  const out: EnabledCheck[] = [];
  for (const check of checks) {
    let severity: SeveritySetting = presetIncludes(preset, check.meta.preset) ? check.meta.defaultSeverity : "off";
    let options: Record<string, unknown> = {};
    for (const layer of ruleLayers) {
      const s = settingFor(layer, check);
      if (s !== undefined) {
        const n = normalizeSetting(s);
        severity = n.severity;
        options = { ...options, ...n.options };
      }
    }
    if (severity !== "off") out.push({ check, severity, options });
  }
  return out;
}
