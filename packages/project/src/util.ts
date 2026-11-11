import * as path from "node:path";

export type Rec = Record<string, unknown>;

export function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asRecord(v: unknown): Rec {
  return isRecord(v) ? v : {};
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** String form of a scalar .yy value (values are usually strings already). */
export function asValueString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** `{ name, path }` reference -> name, or null. */
export function refName(v: unknown): string | null {
  if (!isRecord(v)) return null;
  const n = v["name"];
  return typeof n === "string" && n !== "" ? n : null;
}

/** Absolute path with forward slashes. */
export function normPath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/");
}

/** Join a forward-slash relative path onto a normalised directory. */
export function joinRel(dir: string, rel: string): string {
  const clean = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return dir.endsWith("/") ? dir + clean : `${dir}/${clean}`;
}

export function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}
