/**
 * Every gml-lint check as an ESLint rule (`gml/<check-name>`).
 */

import { allChecks, makeContext, PARSE_ERROR_CODE, Suppressions, type Check, type Diagnostic, type Program } from "@gml-lint/checker";
import type { Node } from "@gml-lint/parser";
import type { GmlParserServices, GmlSourceCode } from "./language.js";

/* Minimal structural types for the parts of ESLint's rule API we use. */
interface RuleFixer {
  replaceTextRange(range: [number, number], text: string): unknown;
}
interface RuleContext {
  sourceCode: GmlSourceCode;
  options: unknown[];
  report(descriptor: {
    loc: { start: { line: number; column: number }; end: { line: number; column: number } };
    message: string;
    fix?: (fixer: RuleFixer) => unknown;
    suggest?: Array<{ desc: string; fix: (fixer: RuleFixer) => unknown }>;
  }): void;
}
export interface GmlRule {
  meta: {
    type: "problem" | "suggestion" | "layout";
    docs: { description: string; url?: string; recommended?: boolean };
    fixable?: "code";
    hasSuggestions?: boolean;
    schema: unknown[];
    language?: string;
  };
  create(context: RuleContext): Record<string, (node: Node) => void>;
}

const suppressionsByProgram = new WeakMap<Program, { checker: unknown; s: Suppressions }>();

function suppressionsFor(program: Program): Suppressions {
  const checker = program.getChecker();
  const hit = suppressionsByProgram.get(program);
  if (hit && hit.checker === checker) return hit.s;
  const presetByCode = new Map(allChecks.map((c) => [c.meta.code, c.meta.preset]));
  const s = new Suppressions(program, { presetOf: (code) => presetByCode.get(code) ?? null });
  suppressionsByProgram.set(program, { checker, s });
  return s;
}

export function getParserServices(context: { sourceCode: unknown }): GmlParserServices {
  const services = (context.sourceCode as Partial<GmlSourceCode>).parserServices;
  if (!services) throw new Error("eslint-plugin-gml: rule requires the gml/gml language (set `language: \"gml/gml\"`).");
  return services;
}

function flush(context: RuleContext, services: GmlParserServices, diagnostics: Diagnostic[]): void {
  if (diagnostics.length === 0) return;
  const kept = suppressionsFor(services.program).filter(services.sourceFile, diagnostics);
  for (const d of kept) {
    const fix = d.fix;
    context.report({
      loc: d.loc,
      message: d.message,
      ...(fix ? { fix: (fixer: RuleFixer) => fix.map((e) => fixer.replaceTextRange([e.range[0], e.range[1]], e.text)) } : {}),
      ...(d.suggestions
        ? { suggest: d.suggestions.map((s) => ({ desc: s.message, fix: (fixer: RuleFixer) => s.edits.map((e) => fixer.replaceTextRange([e.range[0], e.range[1]], e.text)) })) }
        : {}),
    });
  }
}

export function checkToRule(check: Check): GmlRule {
  const m = check.meta;
  return {
    meta: {
      type: m.defaultSeverity === "suggestion" || m.category === "style" ? "suggestion" : "problem",
      docs: { description: `${m.code}: ${m.description}`, ...(m.docs ? { url: m.docs } : {}), recommended: m.preset === "syntax" || m.preset === "recommended" },
      ...(m.fixable ? { fixable: "code" as const } : {}),
      hasSuggestions: true,
      schema: [{ type: "object", additionalProperties: true }],
      language: "gml/gml",
    },
    create(context) {
      const services = getParserServices(context);
      const diagnostics: Diagnostic[] = [];
      if (m.code === PARSE_ERROR_CODE) {
        return {
          Program() {
            for (const e of services.sourceFile.parseErrors) {
              diagnostics.push({ code: m.code, check: m.name, message: e.message, severity: "error", file: services.sourceFile.path, range: e.range, loc: e.loc });
            }
            flush(context, services, diagnostics);
          },
        };
      }
      const options = (context.options[0] as Record<string, unknown> | undefined) ?? {};
      const ctx = makeContext(services.program, services.sourceFile, services.fc, check, m.defaultSeverity, options, diagnostics);
      const visitor = check.create(ctx) as Record<string, ((node: Node, parent: Node | null) => void) | undefined>;
      const listeners: Record<string, (node: Node) => void> = {};
      for (const [key, fn] of Object.entries(visitor)) {
        if (typeof fn !== "function") continue;
        listeners[key] = (node) => fn(node, context.sourceCode.getParent(node) ?? null);
      }
      const userExit = listeners["Program:exit"];
      listeners["Program:exit"] = (node) => {
        userExit?.(node);
        flush(context, services, diagnostics);
      };
      return listeners;
    },
  };
}

export const rules: Record<string, GmlRule> = Object.fromEntries(allChecks.map((c) => [c.meta.name, checkToRule(c)]));

/** Feather code -> rule id, e.g. GM1013 -> "gml/no-undeclared-variable". */
export const ruleIdsByCode: Record<string, string> = Object.fromEntries(allChecks.map((c) => [c.meta.code, `gml/${c.meta.name}`]));
