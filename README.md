# gml-lint

Lints GameMaker projects. Implements GameMaker's Feather rules (GM1000–GM2063) and runs them from the command line or ESLint.

```
packages/
  parser/         GML parser
  project/        .yyp/.yy loader
  checker/        name resolution, type inference, checks; data/GmlSpec.xml is the built-in API
  cli/            gmlc
  eslint-plugin/  eslint-plugin-gml
```

## gmlc

```sh
gmlc                          # check the project in the current folder
gmlc path/to/Game.yyp --preset strict
gmlc --fix
gmlc --format json            # compact | json | github
gmlc rules
```

Exits with 1 if there are errors (or more warnings than `--max-warnings`), 2 on bad usage.

`--spec <file>` checks against another GmlSpec.xml than the bundled one.

### Presets

| Preset | |
|---|---|
| `syntax` | what the compiler rejects |
| `recommended` | default; Feather's "All" profile |
| `strict` | adds Feather's Strict Type checks |
| `all` | adds naming and evaluation-order checks |

### gmlint.config.json

```jsonc
{
  "preset": "recommended",
  "rules": {
    "GM2017": "off",
    "no-undeclared-variable": "error"
  },
  // project paths, or Asset Browser folders with "folder:"
  "ignore": ["folder:Extensions/**", "scripts/__*/**"],
  "overrides": [{ "files": ["folder:Scripts/Prototypes/**"], "preset": "syntax" }]
}
```

### Project checks

List modules under `plugins` (paths relative to the config file). A module exports checks, objects with `meta` and `create`, as its default or named exports:

```ts
// lint/no-debug-message.ts
import type { ProjectCheck } from "@gml-lint/checker";

export default {
  meta: { code: "DS0001", name: "no-debug-message", description: "No debug output" },
  create: (ctx) => ({
    CallExpression(node) {
      if (node.callee.type === "Identifier" && node.callee.name === "show_debug_message") {
        ctx.report({ node, message: "Remove debug output." });
      }
    },
  }),
} satisfies ProjectCheck;
```

```json
{ "plugins": ["lint/no-debug-message.ts"] }
```

`ctx` has the file (`ctx.file.ast`, `ctx.file.docs`), the checker (`ctx.fc.resolve`, `ctx.fc.typeOf`, `ctx.fc.selfAt`) and `ctx.report`. Unless `meta` says otherwise, checks are warnings in the `recommended` preset.

### Suppressing

```gml
// gmlint-disable-next-line GM1013
// gmlint-disable GM2016
// gmlint-enable GM2016
```

Feather's own comments work too (`// Feather ignore GM1010`, `// Feather disable all`, `... in /Scripts/*`).

## ESLint

```js
// eslint.config.js
import gml from "eslint-plugin-gml";

export default [gml.configs.recommended]; // or .syntax, .strict, .all
```

Each file is checked with the nearest `.yyp` above it as context. Set `languageOptions.project` to a `.yyp` path, or `false` to check files on their own.

Custom rules can use the checker:

```js
import { getParserServices } from "eslint-plugin-gml";

export default {
  meta: { type: "problem", schema: [] },
  create(context) {
    const { fc } = getParserServices(context);
    return {
      CallExpression(node) {
        fc.signatureOfCallee(node.callee); // parameters, arg counts, pure, deprecated
        fc.typeOf(node);                   // inferred type
        fc.selfAt(node);                   // what `self` is here
      },
    };
  },
};
```

## JSON output

`gmlc --format json`:

```json
{
  "schemaVersion": 1,
  "tool": { "name": "gmlc", "version": "0.1.0" },
  "project": { "name": "MyGame", "path": "/path/to/MyGame" },
  "summary": { "files": 412, "errors": 0, "warnings": 1, "suggestions": 0 },
  "diagnostics": [
    {
      "code": "GM2022", "check": "unused-pure-result", "severity": "warning",
      "message": "Return value of the pure function 'max' is not being used.",
      "file": "scripts/scr_movement/scr_movement.gml",
      "startLine": 29, "startColumn": 25, "endLine": 29, "endColumn": 55,
      "range": [612, 642]
    }
  ]
}
```

Lines and columns start at 1. `range` is character offsets into the file.

## Limits

The checker only reports what it is sure of. Code where `self` is unknown (script functions called from anywhere, callbacks) is not checked for undeclared variables; add `/// @self obj_name` to a function to fix that. Macros are not expanded.

## Development

```sh
pnpm install
pnpm build
pnpm test
```
