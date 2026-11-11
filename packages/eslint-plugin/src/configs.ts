/**
 * Rule levels for the plugin's configs (`gml.configs.recommended`, ...),
 * keyed by rule name without the `gml/` prefix.
 */

type Level = "warn" | "error";

const levels = {
  /** What the GameMaker compiler rejects. */
  syntax: {
    "no-break-outside-loop": "error", // GM1000
    "no-continue-outside-loop": "error", // GM1001
    "no-globalvar-initializer": "error", // GM1002
    "enum-value-integer": "error", // GM1003
    "no-duplicate-enum-member": "error", // GM1004
    "no-duplicate-enum": "error", // GM1006
    "assignment-target-must-be-variable": "error", // GM1007
    "no-divide-by-zero": "error", // GM1015
    "no-lone-boolean-literal": "error", // GM1016
    "assignment-expected": "error", // GM1022
    "no-lone-number-literal": "error", // GM1025
    "update-target-must-be-variable": "error", // GM1026
    "no-lone-string-literal": "error", // GM1027
    "invalid-array-index": "error", // GM1036
    "syntax-error": "error", // GM1100
  },
  /** Likely bugs. Extends syntax. */
  recommended: {
    "missing-argument": "error", // GM1005
    "no-readonly-assignment": "error", // GM1008
    "no-undefined-enum-member": "error", // GM1014
    "no-deprecated-function": "warn", // GM1017
    "too-many-arguments": "error", // GM1019
    "too-few-arguments": "error", // GM1020
    "no-undefined-function": "error", // GM1021
    "no-deprecated-constant": "warn", // GM1023
    "no-deprecated-variable": "warn", // GM1024
    "no-reserved-identifier": "error", // GM1030
    "no-asset-or-constant-assignment": "error", // GM1031
    "no-argument-gaps": "warn", // GM1032
    "no-argument-outside-function": "error", // GM1034
    "no-duplicate-macro": "warn", // GM1038
    "no-mixed-argument-styles": "error", // GM1040
    "argument-type-mismatch": "warn", // GM1041
    "jsdoc-param-name": "warn", // GM1042
    "wrong-constant-group": "warn", // GM1044
    "jsdoc-type-mismatch": "warn", // GM1045
    "no-local-member-access": "error", // GM1050
    "no-macro-semicolon": "warn", // GM1051
    "no-invalid-constructor-parent": "error", // GM1054
    "no-argument-with-named-parameters": "warn", // GM1055
    "no-new-non-constructor": "error", // GM1058
    "no-duplicate-parameter": "warn", // GM1059
    "call-non-function": "warn", // GM1060
    "jsdoc-malformed-type": "warn", // GM1062
    "no-duplicate-global-function": "warn", // GM1064
    "restore-blendmode": "warn", // GM2000
    "restore-shader": "warn", // GM2003
    "restore-surface-target": "warn", // GM2005
    "no-nested-vertex-batch": "warn", // GM2008
    "no-unopened-vertex-batch": "warn", // GM2009
    "vertex-inside-batch": "warn", // GM2010
    "close-vertex-batch": "warn", // GM2011
    "no-nested-vertex-format": "warn", // GM2012
    "no-unopened-vertex-format": "warn", // GM2013
    "vertex-format-add-inside-format": "warn", // GM2014
    "close-vertex-format": "warn", // GM2015
    "instance-variable-outside-create": "warn", // GM2016
    "no-uninitialized-var-in-loop": "warn", // GM2018
    "restore-valign": "warn", // GM2019
    "no-all-member-access": "warn", // GM2020
    "unused-pure-result": "warn", // GM2022
    "no-undefined-event": "warn", // GM2025
    "restore-halign": "warn", // GM2026
    "no-nested-primitive": "warn", // GM2027
    "no-unopened-primitive": "warn", // GM2028
    "draw-vertex-inside-primitive": "warn", // GM2029
    "close-primitive": "warn", // GM2030
    "no-nested-file-find": "warn", // GM2031
    "no-unopened-file-find": "warn", // GM2032
    "file-find-inside-block": "warn", // GM2033
    "close-file-find": "warn", // GM2034
    "restore-gpu-state": "warn", // GM2035
    "no-script-asset-call": "warn", // GM2039
    "no-event-inherited-without-parent-event": "warn", // GM2040
    "consistent-gpu-state-depth": "warn", // GM2042
    "no-local-outside-scope": "warn", // GM2043
    "no-redeclared-local": "warn", // GM2044
    "consistent-surface-target-depth": "warn", // GM2046
    "no-unreachable": "warn", // GM2047
    "restore-blendenable": "warn", // GM2048
    "restore-zfunc": "warn", // GM2049
    "restore-fog": "warn", // GM2050
    "restore-cullmode": "warn", // GM2051
    "restore-colourwriteenable": "warn", // GM2052
    "restore-alphatestenable": "warn", // GM2053
    "restore-alphatestref": "warn", // GM2054
    "restore-texfilter": "warn", // GM2055
    "restore-texrepeat": "warn", // GM2056
    "restore-draw-colour": "warn", // GM2062
    "restore-draw-alpha": "warn", // GM2063
  },
  /** Feather's Strict Type checks. Extends recommended. */
  strict: {
    "unexpected-type-operation": "warn", // GM1009
    "invalid-type-operation": "warn", // GM1010
    "implicit-bool-cast": "warn", // GM1011
    "no-malformed-variable-addressing": "error", // GM1012
    "no-undeclared-variable": "warn", // GM1013
    "wrong-accessor": "warn", // GM1028
    "dangerous-implicit-cast": "warn", // GM1029
    "inconsistent-return-type": "warn", // GM1035
    "type-reassignment": "warn", // GM1043
    "no-delete-non-struct": "warn", // GM1052
    "ternary-differing-types": "warn", // GM1063
  },
  /** Style. Does not extend anything. */
  stylistic: {
    "no-extra-semicolon": "warn", // GM1033
    "optional-parameters-last": "warn", // GM1056
    "prefer-repeat": "warn", // GM2004
    "var-semicolon": "warn", // GM2007
    "naming-convention": "warn", // GM2017
    "prefer-nullish-coalescing": "warn", // GM2061
  },
} satisfies Record<string, Record<string, Level>>;

const prefixed = (rules: Record<string, Level>): Record<string, Level> =>
  Object.fromEntries(Object.entries(rules).map(([name, level]) => [`gml/${name}`, level]));

/** Rules per config. `recommended` includes `syntax`, `strict` includes `recommended`, `all` includes everything. */
export const configRules: Record<"syntax" | "recommended" | "strict" | "stylistic" | "all", Record<string, Level>> = {
  syntax: prefixed(levels.syntax),
  recommended: prefixed({ ...levels.syntax, ...levels.recommended }),
  strict: prefixed({ ...levels.syntax, ...levels.recommended, ...levels.strict }),
  stylistic: prefixed(levels.stylistic),
  all: prefixed({ ...levels.syntax, ...levels.recommended, ...levels.strict, ...levels.stylistic, "argument-evaluation-order": "warn" }),
};