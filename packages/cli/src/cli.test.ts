import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "./index.js";
import { parseJsonc } from "./config-file.js";

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gmlc-"));
  const resources: string[] = [];
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
    const m = /^scripts\/([^/]+)\//.exec(rel);
    if (m) {
      writeFileSync(join(dir, "scripts", m[1]!, `${m[1]}.yy`), JSON.stringify({ resourceType: "GMScript", name: m[1], parent: { name: "Scripts", path: "folders/Scripts.yy" } }));
      resources.push(`{"id":{"name":"${m[1]}","path":"scripts/${m[1]}/${m[1]}.yy",},},`);
    }
  }
  writeFileSync(join(dir, "Test.yyp"), `{"resourceType":"GMProject","name":"Test","resources":[${resources.join("")}],"Folders":[],"IncludedFiles":[],"configs":{"name":"Default","children":[],},}`);
  return dir;
}

async function run(args: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    out += a.join(" ") + "\n";
  });
  try {
    const code = await main(args);
    return { code, out };
  } finally {
    write.mockRestore();
    err.mockRestore();
    log.mockRestore();
  }
}

describe("gmlc", () => {
  it("parses JSONC configs", () => {
    expect(parseJsonc('{ // c\n "a": [1, 2,], /* x */ "b": "//not a comment", }')).toEqual({ a: [1, 2], b: "//not a comment" });
  });

  it("reports syntax errors and exits 1", async () => {
    const dir = makeProject({ "scripts/s/s.gml": "a = ;\nbreak;" });
    const r = await run([dir, "--format", "json"]);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.out);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.diagnostics.map((d: { code: string; startLine: number }) => `${d.code}@${d.startLine}`)).toEqual(["GM1100@1", "GM1000@2"]);
  });

  it("exits 0 for clean projects and honours --rule", async () => {
    const dir = makeProject({ "scripts/s/s.gml": "break;" });
    const r = await run([dir, "--rule", "GM1000=off", "--format", "compact"]);
    expect(r.code).toBe(0);
  });

  it("honours Feather and gmlint directives", async () => {
    const dir = makeProject({ "scripts/s/s.gml": "// Feather disable GM1000\nbreak;\n// gmlint-disable-next-line GM1001\ncontinue;" });
    const r = await run([dir, "--format", "compact", "--rule", "GM2047=off"]);
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
  });

  it("writes GitHub annotations", async () => {
    const dir = makeProject({ "scripts/s/s.gml": "break;" });
    const gh = (await run([dir, "--format", "github"])).out;
    expect(gh).toMatch(/^::error file=scripts\/s\/s.gml,line=1,col=1/);
  });

  it("lists rules", async () => {
    const r = await run(["rules", "--format", "json"]);
    expect(JSON.parse(r.out).some((m: { code: string }) => m.code === "GM1013")).toBe(true);
  });
});
