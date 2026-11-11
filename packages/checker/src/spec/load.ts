import { readFileSync } from "node:fs";
import { parseXml, type XmlElement } from "./xml.js";
import type {
  GmlSpec,
  SpecConstant,
  SpecEnumeration,
  SpecEnumMember,
  SpecField,
  SpecFunction,
  SpecParameter,
  SpecStructure,
  SpecVariable,
} from "./types.js";

const SPEC_ROOT_ELEMENT = "GameMakerLanguageSpec";

export function createEmptySpec(): GmlSpec {
  return {
    sources: [],
    runtimeVersion: null,
    functions: new Map(),
    variables: new Map(),
    constants: new Map(),
    structures: new Map(),
    enumerations: new Map(),
  };
}

function bool(v: string | undefined, dflt = false): boolean {
  if (v === undefined) return dflt;
  const t = v.trim().toLowerCase();
  if (t === "true" || t === "1") return true;
  if (t === "false" || t === "0") return false;
  return dflt;
}

function optBool(v: string | undefined): boolean | null {
  return v === undefined ? null : bool(v);
}

function str(v: string | undefined): string {
  return v ?? "";
}

function optStr(v: string | undefined): string | null {
  return v === undefined || v === "" ? null : v;
}

function childrenNamed(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter((c) => c.name === name);
}

function readFunction(el: XmlElement): SpecFunction | undefined {
  const a = el.attrs;
  const name = a["Name"];
  if (!name) return undefined;
  let description = "";
  const parameters: SpecParameter[] = [];
  for (const c of el.children) {
    if (c.name === "Description") description = c.text.trim();
    else if (c.name === "Parameter") {
      const pa = c.attrs;
      const pname = str(pa["Name"]);
      parameters.push({
        name: pname,
        type: str(pa["Type"]),
        optional: bool(pa["Optional"]),
        rest: pname === "...",
        coerce: optBool(pa["Coerce"]),
        description: c.text.trim(),
      });
    }
  }
  let minArgs = 0;
  for (const p of parameters) {
    if (p.optional || p.rest) break;
    minArgs++;
  }
  const maxArgs = parameters.some((p) => p.rest) ? Infinity : parameters.length;
  return {
    name,
    parameters,
    returnType: str(a["ReturnType"]),
    pure: bool(a["Pure"]),
    deprecated: bool(a["Deprecated"]),
    locale: optStr(a["Locale"]),
    featureFlag: optStr(a["FeatureFlag"]),
    description,
    minArgs,
    maxArgs,
  };
}

function readVariable(el: XmlElement): SpecVariable | undefined {
  const a = el.attrs;
  const name = a["Name"];
  if (!name) return undefined;
  return {
    name,
    type: str(a["Type"]),
    deprecated: bool(a["Deprecated"]),
    get: bool(a["Get"], true),
    set: bool(a["Set"]),
    instance: bool(a["Instance"]),
    locale: optStr(a["Locale"]),
    featureFlag: optStr(a["FeatureFlag"]),
    description: el.text.trim(),
  };
}

function readConstant(el: XmlElement): SpecConstant | undefined {
  const a = el.attrs;
  const name = a["Name"];
  if (!name) return undefined;
  return {
    name,
    class: optStr(a["Class"]),
    type: str(a["Type"]),
    deprecated: bool(a["Deprecated"]),
    locale: optStr(a["Locale"]),
    featureFlag: optStr(a["FeatureFlag"]),
    description: el.text.trim(),
  };
}

function readStructure(el: XmlElement): SpecStructure | undefined {
  const name = el.attrs["Name"];
  if (!name) return undefined;
  const fields: SpecField[] = [];
  for (const f of childrenNamed(el, "Field")) {
    const a = f.attrs;
    fields.push({
      name: str(a["Name"]),
      type: str(a["Type"]),
      get: bool(a["Get"], true),
      set: bool(a["Set"]),
      description: f.text.trim(),
    });
  }
  return { name, fields };
}

function readEnumeration(el: XmlElement): SpecEnumeration | undefined {
  const name = el.attrs["Name"];
  if (!name) return undefined;
  const members: SpecEnumMember[] = [];
  for (const m of childrenNamed(el, "Member")) {
    const a = m.attrs;
    const raw = a["Value"];
    members.push({
      name: str(a["Name"]),
      value: raw === undefined || raw.trim() === "" ? NaN : Number(raw),
      deprecated: bool(a["Deprecated"]),
      description: m.text.trim(),
    });
  }
  return { name, members };
}

/**
 * Parse the text of a GmlSpec.xml document and merge it into `into`
 * (or a fresh spec). Later entries override earlier ones with the same name.
 */
export function parseSpecXml(xml: string, source?: string, into?: GmlSpec): GmlSpec {
  const spec = into ?? createEmptySpec();
  const root = parseXml(xml);
  if (root.name !== SPEC_ROOT_ELEMENT) {
    throw new Error(
      `${source ?? "GmlSpec"}: expected root element <${SPEC_ROOT_ELEMENT}>, found <${root.name}>`,
    );
  }
  if (source !== undefined) spec.sources.push(source);
  const rv = optStr(root.attrs["RuntimeVersion"]);
  if (rv !== null) spec.runtimeVersion = rv;

  for (const section of root.children) {
    switch (section.name) {
      case "Functions":
        readEntries(section, "Function", readFunction, spec.functions);
        break;
      case "Variables":
        readEntries(section, "Variable", readVariable, spec.variables);
        break;
      case "Constants":
        readEntries(section, "Constant", readConstant, spec.constants);
        break;
      case "Structures":
        readEntries(section, "Structure", readStructure, spec.structures);
        break;
      case "Enumerations":
        readEntries(section, "Enumeration", readEnumeration, spec.enumerations);
        break;
    }
  }
  return spec;
}

function readEntries<T extends { name: string }>(
  section: XmlElement,
  tag: string,
  read: (el: XmlElement) => T | undefined,
  into: Map<string, T>,
): void {
  for (const c of section.children) {
    if (c.name !== tag) continue;
    const entry = read(c);
    if (entry) into.set(entry.name, entry);
  }
}

/**
 * Load and merge one or more GmlSpec.xml files. Later files add to, and
 * override same-named entries of, earlier ones.
 */
export function loadSpecFiles(paths: string | string[]): GmlSpec {
  const list = typeof paths === "string" ? [paths] : paths;
  const spec = createEmptySpec();
  for (const p of list) {
    const xml = readFileSync(p, "utf8");
    try {
      parseSpecXml(xml, p, spec);
    } catch (err) {
      if (err instanceof Error && !err.message.startsWith(p)) {
        throw new Error(`${p}: ${err.message}`, { cause: err });
      }
      throw err;
    }
  }
  return spec;
}
