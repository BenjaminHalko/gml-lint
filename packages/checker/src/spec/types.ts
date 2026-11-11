/**
 * The GameMaker built-in API, as described by the runtime's `GmlSpec.xml`.
 *
 * Type strings are kept exactly as written in the spec (Feather's type
 * syntax, e.g. "Real", "Id.Instance", "Array[Id.Instance]",
 * "Asset.GMObject,Id.Instance", "Constant.SeqPlay", "ArgumentIdentity").
 * The checker parses them; this package only loads data.
 */

export interface SpecParameter {
  /** Parameter name. `"..."` marks a rest parameter. */
  name: string;
  /** Raw type string. */
  type: string;
  optional: boolean;
  /** `name === "..."` */
  rest: boolean;
  /** Spec `Coerce` attribute, when present. */
  coerce: boolean | null;
  description: string;
}

export interface SpecFunction {
  name: string;
  parameters: SpecParameter[];
  returnType: string;
  pure: boolean;
  deprecated: boolean;
  /** Spec `Locale` attribute ("GB" / "US" spelling variants), when present. */
  locale: string | null;
  featureFlag: string | null;
  description: string;
  /** Required argument count (non-optional, non-rest parameters, counted up to the first optional one). */
  minArgs: number;
  /** Maximum argument count; `Infinity` when there is a rest parameter. */
  maxArgs: number;
}

export interface SpecVariable {
  name: string;
  type: string;
  deprecated: boolean;
  /** Readable (`Get`). */
  get: boolean;
  /** Writable (`Set`). */
  set: boolean;
  /** Per-instance built-in (x, y, sprite_index...) vs global (room, fps...). */
  instance: boolean;
  locale: string | null;
  featureFlag: string | null;
  description: string;
}

export interface SpecConstant {
  name: string;
  /** Constant group, e.g. "AssetType", "MouseButton". */
  class: string | null;
  type: string;
  deprecated: boolean;
  locale: string | null;
  featureFlag: string | null;
  description: string;
}

export interface SpecField {
  name: string;
  type: string;
  get: boolean;
  set: boolean;
  description: string;
}

export interface SpecStructure {
  name: string;
  fields: SpecField[];
}

export interface SpecEnumMember {
  name: string;
  value: number;
  deprecated: boolean;
  description: string;
}

export interface SpecEnumeration {
  name: string;
  members: SpecEnumMember[];
}

export interface GmlSpec {
  /** File(s) the spec was loaded from. */
  sources: string[];
  /** `RuntimeVersion` attribute of the root element. */
  runtimeVersion: string | null;
  functions: Map<string, SpecFunction>;
  variables: Map<string, SpecVariable>;
  constants: Map<string, SpecConstant>;
  structures: Map<string, SpecStructure>;
  enumerations: Map<string, SpecEnumeration>;
}
