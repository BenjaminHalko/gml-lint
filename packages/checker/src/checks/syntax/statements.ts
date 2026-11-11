/**
 * Statement- and expression-level Feather rules: malformed statements,
 * assignment targets, semicolons, unreachable code and local redeclarations.
 */

import type * as AST from "@gml-lint/parser";
import { defineCheck, type Check } from "../api.js";
import { unparen } from "../util.js";
import { chainRoot, docs, isDirective, isNumberLiteral, isStringLiteral, statementList } from "./helpers.js";

// ---------------------------------------------------------------------------
// Lone literals / identifiers as statements
// ---------------------------------------------------------------------------

function loneLiteralCheck(code: "GM1016" | "GM1025" | "GM1027", what: "boolean" | "number" | "string"): Check {
  const matches = (e: AST.Node) =>
    what === "boolean" ? e.type === "Literal" && e.kind === "boolean" : what === "number" ? isNumberLiteral(e) : isStringLiteral(e);
  const message = `A ${what} literal was unexpected at this time.`;
  return defineCheck({
    meta: {
      code,
      name: `no-lone-${what}-literal`,
      description: message,
      category: "syntax",
      defaultSeverity: "error",
      preset: "syntax",
      feather: true,
      docs: docs(code),
    },
    create(ctx) {
      return {
        ExpressionStatement(node) {
          if (node.expression.type === "AssignmentExpression") {
            // `0xFF = 1`: a number literal as an assignment target (GM1025 only).
            if (what === "number" && isNumberLiteral(unparen(node.expression.left))) {
              ctx.report({ node: node.expression.left, message });
            }
            return;
          }
          const e = unparen(node.expression);
          if (matches(e)) ctx.report({ node: e, message });
        },
      };
    },
  });
}

export const GM1016 = loneLiteralCheck("GM1016", "boolean");
export const GM1025 = loneLiteralCheck("GM1025", "number");
export const GM1027 = loneLiteralCheck("GM1027", "string");

/** Macros meant to be used as statements even when not declared in the project (GMLive). */
const STATEMENT_MACROS = new Set(["live_auto_call", "live_auto_call_ext"]);

export const GM1022 = defineCheck({
  meta: {
    code: "GM1022",
    name: "assignment-expected",
    description: "An assignment was expected at this time.",
    category: "syntax",
    defaultSeverity: "error",
    preset: "syntax",
    feather: true,
    docs: docs("GM1022"),
  },
  create(ctx) {
    return {
      ExpressionStatement(node) {
        const e = node.expression;
        if (e.type !== "Identifier" && e.type !== "MemberExpression") return;
        const root = chainRoot(e);
        if (!root) return;
        if (STATEMENT_MACROS.has(root.name)) return;
        if (ctx.fc.resolve(root)?.kind === "macro") return;
        ctx.report({ node: e, message: "An assignment was expected at this time." });
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Assignment / update targets
// ---------------------------------------------------------------------------

function isAssignableSyntax(e: AST.Expression): boolean {
  e = unparen(e);
  return e.type === "Identifier" || e.type === "MemberExpression" || e.type === "IndexExpression";
}

export const GM1007 = defineCheck({
  meta: {
    code: "GM1007",
    name: "assignment-target-must-be-variable",
    description: "Left-hand side of an assignment must be a variable.",
    category: "syntax",
    defaultSeverity: "error",
    preset: "syntax",
    feather: true,
    docs: docs("GM1007"),
  },
  create(ctx) {
    return {
      AssignmentExpression(node) {
        const left = unparen(node.left);
        if (isAssignableSyntax(left) || isNumberLiteral(left) || left.type === "InvalidExpression") return;
        ctx.report({ node: node.left, message: "Left-hand side of an assignment must be a variable." });
      },
    };
  },
});

const NOT_VARIABLE_KINDS = new Set(["builtin-constant", "builtin-function", "global-function", "asset", "script"]);

export const GM1026 = defineCheck({
  meta: {
    code: "GM1026",
    name: "update-target-must-be-variable",
    description: "Left-hand side of postfix expression must be a variable.",
    category: "syntax",
    defaultSeverity: "error",
    preset: "syntax",
    feather: true,
    docs: docs("GM1026"),
  },
  create(ctx) {
    return {
      UpdateExpression(node) {
        const arg = unparen(node.argument);
        let bad: boolean;
        if (arg.type === "Identifier") {
          const r = ctx.fc.resolve(arg);
          bad = !!r && NOT_VARIABLE_KINDS.has(r.kind);
        } else {
          bad = !isAssignableSyntax(arg) && arg.type !== "InvalidExpression";
        }
        if (!bad) return;
        ctx.report({
          node: node.argument,
          message: node.prefix ? "Operand of prefix expression must be a variable." : "Left-hand side of postfix expression must be a variable.",
        });
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Division by zero
// ---------------------------------------------------------------------------

const isZero = (e: AST.Expression) => {
  const u = unparen(e);
  return isNumberLiteral(u) && u.value === 0;
};

export const GM1015 = defineCheck({
  meta: {
    code: "GM1015",
    name: "no-divide-by-zero",
    description: "Cannot divide or modulo expression by 0.",
    category: "syntax",
    defaultSeverity: "error",
    preset: "syntax",
    feather: true,
    docs: docs("GM1015"),
  },
  create(ctx) {
    const message = "Cannot divide or modulo expression by 0.";
    return {
      BinaryExpression(node) {
        const op = node.operator;
        if ((op === "/" || op === "%" || op === "mod" || op === "div") && isZero(node.right)) ctx.report({ node, message });
      },
      AssignmentExpression(node) {
        if ((node.operator === "/=" || node.operator === "%=") && isZero(node.right)) ctx.report({ node, message });
      },
    };
  },
});

// ---------------------------------------------------------------------------
// `all.x`
// ---------------------------------------------------------------------------

export const GM2020 = defineCheck({
  meta: {
    code: "GM2020",
    name: "no-all-member-access",
    description: "all cannot be referenced in this way.",
    category: "syntax",
    defaultSeverity: "warning",
    preset: "recommended",
    feather: true,
    docs: docs("GM2020"),
  },
  create(ctx) {
    return {
      MemberExpression(node) {
        const o = node.object;
        if (o.type !== "Identifier" || o.name !== "all") return;
        const r = ctx.fc.resolve(o);
        if (r?.kind === "keyword" && r.name === "all") ctx.report({ node, message: "all cannot be referenced in this way." });
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Semicolons
// ---------------------------------------------------------------------------

export const GM1033 = defineCheck({
  meta: {
    code: "GM1033",
    name: "no-extra-semicolon",
    description: "Possibly unintended or misplaced semicolon.",
    category: "style",
    defaultSeverity: "suggestion",
    preset: "recommended",
    feather: true,
    fixable: true,
    docs: docs("GM1033"),
  },
  create(ctx) {
    const text = ctx.file.text;
    const check = (node: AST.Program | AST.BlockStatement | AST.SwitchCase) => {
      const list = statementList(node)!;
      for (let i = 1; i < list.length; i++) {
        const cur = list[i]!;
        if (cur.type !== "EmptyStatement") continue;
        const prev = list[i - 1]!;
        if (isDirective(prev) || prev.loc.end.line !== cur.loc.start.line) continue;
        const last = text[prev.range[1] - 1];
        if (last !== ";" && last !== "}") continue;
        const between = text.slice(prev.range[1], cur.range[0]);
        const start = /^[ \t]*$/.test(between) ? prev.range[1] : cur.range[0];
        ctx.report({ node: cur, message: "Possibly unintended or misplaced semicolon.", fix: { range: [start, cur.range[1]], text: "" } });
      }
    };
    return { Program: check, BlockStatement: check, SwitchCase: check };
  },
});

export const GM2007 = defineCheck({
  meta: {
    code: "GM2007",
    name: "var-semicolon",
    description: "var expression should be terminated with a ';' (semicolon.)",
    category: "style",
    defaultSeverity: "suggestion",
    preset: "recommended",
    feather: true,
    fixable: true,
    docs: docs("GM2007"),
  },
  create(ctx) {
    return {
      VariableDeclaration(node, parent) {
        if (node.kind !== "var" || node.semicolon || node.declarations.length === 0) return;
        if (parent?.type === "ForStatement" && parent.init === node) return;
        ctx.report({
          node,
          message: "var expression should be terminated with a ';' (semicolon.)",
          fix: { range: [node.range[1], node.range[1]], text: ";" },
        });
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Unreachable code
// ---------------------------------------------------------------------------

const TERMINATORS = new Set(["ReturnStatement", "ExitStatement", "BreakStatement", "ContinueStatement", "ThrowStatement"]);

/** Statements that do not execute at their position (or are not code). */
function isInert(s: AST.Statement): boolean {
  return (
    s.type === "EmptyStatement" ||
    s.type === "FunctionDeclaration" ||
    s.type === "EnumDeclaration" ||
    s.type === "InvalidStatement" ||
    isDirective(s)
  );
}

export const GM2047 = defineCheck({
  meta: {
    code: "GM2047",
    name: "no-unreachable",
    description: "Unreachable code.",
    category: "syntax",
    defaultSeverity: "warning",
    preset: "recommended",
    feather: true,
    docs: docs("GM2047"),
  },
  create(ctx) {
    const check = (node: AST.Program | AST.BlockStatement | AST.SwitchCase) => {
      const list = statementList(node)!;
      let terminated = false;
      for (const s of list) {
        if (s.type === "DefineDirective") terminated = false; // a new legacy script starts
        if (terminated && !isInert(s)) {
          ctx.report({ node: s, message: "Unreachable code." });
          return;
        }
        if (TERMINATORS.has(s.type)) terminated = true;
      }
    };
    return { Program: check, BlockStatement: check, SwitchCase: check };
  },
});

// ---------------------------------------------------------------------------
// Local redeclaration
// ---------------------------------------------------------------------------

export const GM2044 = defineCheck({
  meta: {
    code: "GM2044",
    name: "no-redeclared-local",
    description: "Local variable is already declared.",
    category: "syntax",
    defaultSeverity: "warning",
    preset: "recommended",
    feather: true,
    docs: docs("GM2044"),
  },
  create(ctx) {
    const fc = ctx.fc;
    /** The `var` statement declaring `id`, or null for parameters/statics. */
    const varDeclOf = (id: AST.Identifier): AST.VariableDeclaration | null => {
      const d = fc.parent(id);
      if (d?.type !== "VariableDeclarator") return null;
      const decl = fc.parent(d);
      return decl?.type === "VariableDeclaration" && decl.kind === "var" ? decl : null;
    };
    return {
      Program() {
        for (const scope of fc.scopes()) {
          for (const sym of scope.locals.values()) {
            if (sym.declarations.length < 2 || sym.kind === "static") continue;
            const message = `Local variable '${sym.name}' is already declared.`;
            if (sym.kind === "parameter") {
              // `function f(a) { var a; }`: the var shadows the parameter.
              for (const id of sym.declarations) if (varDeclOf(id)) ctx.report({ node: id, message });
              continue;
            }
            // Region in which each earlier `var` is visible: its statement list,
            // or the `for` statement for loop counters. A later `var` inside that
            // region redeclares it; sibling regions (sequential loops, other
            // if/switch branches) are left alone.
            const regions: AST.Node[] = [];
            for (const id of sym.declarations) {
              const decl = varDeclOf(id);
              if (!decl) continue;
              const region = fc.parent(decl);
              if (!region) continue;
              if (regions.length > 0) {
                const anc = new Set(fc.ancestors(id));
                if (regions.some((r) => anc.has(r))) ctx.report({ node: id, message });
              }
              regions.push(region);
            }
          }
        }
      },
    };
  },
});

export const statementChecks = [GM1007, GM1015, GM1016, GM1022, GM1025, GM1026, GM1027, GM1033, GM2007, GM2020, GM2044, GM2047];
