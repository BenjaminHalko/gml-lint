import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSpec, parseSpecXml, parseXml, XmlParseError } from "./index.js";

const FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<GameMakerLanguageSpec xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" RuntimeVersion="2022.4" Module="Base">
  <Functions>
    <Function Name="draw_sprite" Deprecated="false" ReturnType="Undefined" Pure="false">
      <Description>
        Draws a sprite.
      </Description>
      <Parameter Name="sprite" Type="Asset.GMSprite" Optional="false">The sprite.</Parameter>
      <Parameter Name="subimg" Type="Real" Optional="false">The frame.</Parameter>
      <Parameter Name="x" Type="Real" Optional="false" />
      <Parameter Name="y" Type="Real" Optional="false" />
    </Function>
    <Function Name="max" Deprecated="false" ReturnType="Real" Pure="true">
      <Description>Max of values.</Description>
      <Parameter Name="val0" Type="Real" Optional="false">First.</Parameter>
      <Parameter Name="..." Type="Real" Optional="false">Rest.</Parameter>
    </Function>
    <Function Name="show_debug_message" Deprecated="false" ReturnType="Undefined" Pure="false">
      <Description>Debug.</Description>
      <Parameter Name="string_or_format" Type="Any" Optional="false">Msg.</Parameter>
      <Parameter Name="..." Type="ArgumentIdentity" Optional="true">Values.</Parameter>
    </Function>
    <Function Name="opt_mid" Deprecated="true" ReturnType="Bool" Pure="false" Locale="GB" FeatureFlag="rollback">
      <Description>a &lt; b &amp;&amp; c &gt; d &quot;q&quot; &apos;s&apos; &#65;&#x42;</Description>
      <Parameter Name="a" Type="Real" Optional="false">A</Parameter>
      <Parameter Name="b" Type="Real" Optional="true">B</Parameter>
      <Parameter Name="c" Type="Id.DsGrid" Coerce="true" Optional="false">C</Parameter>
    </Function>
    <Function Name="no_params" Deprecated="false" ReturnType="Struct.AnimCurve" Pure="true">
      <Description>None.</Description>
    </Function>
  </Functions>
  <Variables>
    <Variable Name="instance_count" Type="Real" Deprecated="false" Get="true" Set="false" Instance="false">Count of instances.</Variable>
    <Variable Name="x" Type="Real" Deprecated="false" Get="true" Set="true" Instance="true">  X pos.  </Variable>
    <Variable Name="background_colour" Type="Real" Deprecated="true" Get="true" Set="true" Instance="false" Locale="GB"></Variable>
  </Variables>
  <Constants>
    <Constant Name="$$implicit_argument$$" Type="Undefined"></Constant>
    <Constant Name="asset_object" Class="AssetType" Type="Real" Deprecated="false">The given name refers to an object.</Constant>
    <Constant Name="c_white" Class="Colour" Type="Constant.Colour" Deprecated="false" Locale="GB">White</Constant>
    <Constant Name="old_const" Type="Real" Deprecated="true"/>
  </Constants>
  <Structures>
    <Structure Name="Sequence">
      <Field Name="name" Type="String" Get="true" Set="true">The name.</Field>
      <Field Name="length" Type="Real" Get="true" Set="false"></Field>
    </Structure>
    <Structure Name="Single">
      <Field Name="only" Type="Real" Get="true" Set="true">Only field.</Field>
    </Structure>
  </Structures>
  <Enumerations>
    <Enumeration Name="AudioEffectType">
      <Member Name="Bitcrusher" Value="0" Deprecated="false">Distorts.</Member>
      <Member Name="Delay" Value="1" Deprecated="true">Echo.</Member>
    </Enumeration>
    <Enumeration Name="Neg">
      <Member Name="m" Value="-3" Deprecated="false"><![CDATA[raw <b>&amp;</b>]]></Member>
    </Enumeration>
  </Enumerations>
</GameMakerLanguageSpec>
`;

describe("parseSpecXml", () => {
  const spec = parseSpecXml(FIXTURE, "fixture.xml");

  it("reads root metadata", () => {
    expect(spec.sources).toEqual(["fixture.xml"]);
    expect(spec.runtimeVersion).toBe("2022.4");
  });

  it("reads functions with fixed arity", () => {
    const f = spec.functions.get("draw_sprite");
    expect(f).toBeDefined();
    expect(f?.minArgs).toBe(4);
    expect(f?.maxArgs).toBe(4);
    expect(f?.returnType).toBe("Undefined");
    expect(f?.pure).toBe(false);
    expect(f?.deprecated).toBe(false);
    expect(f?.locale).toBeNull();
    expect(f?.featureFlag).toBeNull();
    expect(f?.description).toBe("Draws a sprite.");
    expect(f?.parameters.map((p) => p.name)).toEqual(["sprite", "subimg", "x", "y"]);
    expect(f?.parameters[0]).toEqual({
      name: "sprite",
      type: "Asset.GMSprite",
      optional: false,
      rest: false,
      coerce: null,
      description: "The sprite.",
    });
    expect(f?.parameters[2]?.description).toBe("");
  });

  it("handles rest parameters (optional or not)", () => {
    const max = spec.functions.get("max");
    expect(max?.minArgs).toBe(1);
    expect(max?.maxArgs).toBe(Infinity);
    expect(max?.pure).toBe(true);
    expect(max?.parameters[1]?.rest).toBe(true);
    expect(max?.parameters[1]?.optional).toBe(false);

    const sdm = spec.functions.get("show_debug_message");
    expect(sdm?.minArgs).toBe(1);
    expect(sdm?.maxArgs).toBe(Infinity);
    expect(sdm?.parameters[1]?.rest).toBe(true);
    expect(sdm?.parameters[1]?.optional).toBe(true);
  });

  it("counts minArgs up to the first optional parameter", () => {
    const f = spec.functions.get("opt_mid");
    expect(f?.minArgs).toBe(1);
    expect(f?.maxArgs).toBe(3);
    expect(f?.deprecated).toBe(true);
    expect(f?.locale).toBe("GB");
    expect(f?.featureFlag).toBe("rollback");
    expect(f?.parameters[2]?.coerce).toBe(true);
    expect(f?.parameters[0]?.coerce).toBeNull();
  });

  it("handles functions without parameters", () => {
    const f = spec.functions.get("no_params");
    expect(f?.parameters).toEqual([]);
    expect(f?.minArgs).toBe(0);
    expect(f?.maxArgs).toBe(0);
  });

  it("decodes entities", () => {
    expect(spec.functions.get("opt_mid")?.description).toBe(`a < b && c > d "q" 's' AB`);
    expect(spec.enumerations.get("Neg")?.members[0]?.description).toBe("raw <b>&amp;</b>");
  });

  it("reads variables", () => {
    const ic = spec.variables.get("instance_count");
    expect(ic).toEqual({
      name: "instance_count",
      type: "Real",
      deprecated: false,
      get: true,
      set: false,
      instance: false,
      locale: null,
      featureFlag: null,
      description: "Count of instances.",
    });
    const x = spec.variables.get("x");
    expect(x?.instance).toBe(true);
    expect(x?.set).toBe(true);
    expect(x?.description).toBe("X pos.");
    const bg = spec.variables.get("background_colour");
    expect(bg?.deprecated).toBe(true);
    expect(bg?.locale).toBe("GB");
    expect(bg?.description).toBe("");
  });

  it("reads constants with and without Class/Deprecated", () => {
    const imp = spec.constants.get("$$implicit_argument$$");
    expect(imp).toEqual({
      name: "$$implicit_argument$$",
      class: null,
      type: "Undefined",
      deprecated: false,
      locale: null,
      featureFlag: null,
      description: "",
    });
    expect(spec.constants.get("asset_object")?.class).toBe("AssetType");
    expect(spec.constants.get("c_white")?.type).toBe("Constant.Colour");
    expect(spec.constants.get("c_white")?.locale).toBe("GB");
    expect(spec.constants.get("old_const")?.deprecated).toBe(true);
    expect(spec.constants.get("old_const")?.class).toBeNull();
  });

  it("reads structures (single and multiple fields)", () => {
    const seq = spec.structures.get("Sequence");
    expect(seq?.fields).toEqual([
      { name: "name", type: "String", get: true, set: true, description: "The name." },
      { name: "length", type: "Real", get: true, set: false, description: "" },
    ]);
    expect(spec.structures.get("Single")?.fields).toHaveLength(1);
  });

  it("reads enumerations", () => {
    const e = spec.enumerations.get("AudioEffectType");
    expect(e?.members).toEqual([
      { name: "Bitcrusher", value: 0, deprecated: false, description: "Distorts." },
      { name: "Delay", value: 1, deprecated: true, description: "Echo." },
    ]);
    expect(spec.enumerations.get("Neg")?.members[0]?.value).toBe(-3);
  });

  it("rejects a wrong root element and malformed XML", () => {
    expect(() => parseSpecXml("<Other/>")).toThrow(/GameMakerLanguageSpec/);
    expect(() => parseXml("<a><b></a>")).toThrow(XmlParseError);
    expect(() => parseXml("<a>")).toThrow(XmlParseError);
  });
});


const mkSpec = (inner: string, version: string) =>
  `<?xml version="1.0"?><GameMakerLanguageSpec RuntimeVersion="${version}"><Functions>${inner}</Functions></GameMakerLanguageSpec>`;

describe("loadSpec", () => {
  it("merges multiple files, later overriding", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gml-spec-"));
    const a = join(tmp, "a.xml");
    const b = join(tmp, "b.xml");
    writeFileSync(a, mkSpec(`<Function Name="f" ReturnType="Real" Pure="true"/><Function Name="g" ReturnType="Real" Pure="true"/>`, "1"));
    writeFileSync(b, mkSpec(`<Function Name="f" ReturnType="String" Pure="false"/><Function Name="h" ReturnType="Bool" Pure="false"/>`, "2"));
    const spec = loadSpec([a, b]);
    expect(spec.sources).toEqual([a, b]);
    expect(spec.runtimeVersion).toBe("2");
    expect([...spec.functions.keys()].sort()).toEqual(["f", "g", "h"]);
    expect(spec.functions.get("f")?.returnType).toBe("String");
  });

  it("loads the bundled GmlSpec.xml by default", () => {
    const spec = loadSpec();
    expect(spec).toBe(loadSpec());
    expect(spec.functions.size).toBeGreaterThan(2000);
    expect(spec.functions.get("draw_sprite")).toMatchObject({ minArgs: 4, maxArgs: 4 });
    expect(spec.functions.get("max")).toMatchObject({ maxArgs: Infinity, pure: true });
    expect(spec.functions.get("show_debug_message")?.minArgs).toBe(1);
    expect(spec.variables.get("instance_count")).toMatchObject({ get: true, set: false });
    expect(spec.variables.get("x")?.instance).toBe(true);
    expect(spec.constants.has("c_white")).toBe(true);
  });
});