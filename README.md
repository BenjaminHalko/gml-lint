# gml-lint

ESLint plugin for GameMaker projects. Implements GameMaker's Feather rules (GM1000–GM2063).

```
packages/
  parser/         GML parser
  project/        .yyp/.yy loader
  checker/        name resolution, type inference, checks; data/GmlSpec.xml is the built-in API
  eslint-plugin/  eslint-plugin-gml
```

## Setup

```js
// eslint.config.js
import gml, { assetFolderIgnores } from "eslint-plugin-gml";

export default [
  { ignores: assetFolderIgnores("MyGame", ["Extensions/**"]) }, // skip libraries by Asset Browser folder
  gml.configs.recommended,
];
```

```sh
npx eslint MyGame
npx eslint MyGame --fix
```

Each file is checked with the nearest `.yyp` above it as context. Set `languageOptions.project` to a `.yyp` path, or `false` to check files on their own, and `languageOptions.spec` to use another GmlSpec.xml than the bundled one.

## Configs

| Config | |
|---|---|
| `gml.configs.syntax` | what the compiler rejects |
| `gml.configs.recommended` | likely bugs; includes `syntax` |
| `gml.configs.strict` | adds Feather's Strict Type checks |
| `gml.configs.stylistic` | semicolons, `repeat`, `??`, parameter order, naming |
| `gml.configs.all` | everything |

Rules are named `gml/<name>`; `gml.ruleIdsByCode.GM1013` gives the name for a Feather code. `npx eslint --print-config file.gml` shows what is enabled.

## Suppressing

`// eslint-disable-next-line gml/no-undeclared-variable` and the other ESLint comments work. So do Feather's (`// Feather ignore GM1010`, `// Feather disable all`, `... in /Scripts/*`).

## Project rules

Write ordinary ESLint rules; `getParserServices` gives them the checker:

```js
// lint/no-debug-message.js
import { getParserServices } from "eslint-plugin-gml";

export default {
  meta: { type: "problem", schema: [] },
  create(context) {
    const { fc } = getParserServices(context);
    return {
      CallExpression(node) {
        if (node.callee.type === "Identifier" && fc.resolve(node.callee)?.kind === "builtin-function" && node.callee.name === "show_debug_message") {
          context.report({ node, message: "Remove debug output." });
        }
      },
    };
  },
};
```

```js
// eslint.config.js
import noDebugMessage from "./lint/no-debug-message.js";

export default [
  gml.configs.recommended,
  { files: ["**/*.gml"], plugins: { game: { rules: { "no-debug-message": noDebugMessage } } }, rules: { "game/no-debug-message": "error" } },
];
```

`fc` answers `resolve(identifier)`, `resolveMember(node)`, `typeOf(expr)`, `selfAt(node)` and `signatureOfCallee(callee)`. `getParserServices(context).sourceFile` has the AST, comments and JSDoc (`docs`).

## Limits

The checker only reports what it is sure of. Code where `self` is unknown (script functions called from anywhere, callbacks) is not checked for undeclared variables; add `/// @self obj_name` to a function to fix that. Macros are not expanded.

## Development

```sh
pnpm install
pnpm build
pnpm test
```
