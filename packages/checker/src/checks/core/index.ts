/**
 * Core checks. Conventions shared by all check modules:
 *  - one `defineCheck` per Feather code, kebab-case `name`
 *  - messages copied from Feather's wording, with placeholders filled in
 *  - stay silent when the checker cannot be sure (unknown types/contexts)
 */

import type * as AST from "@gml-lint/parser";
import { defineCheck, FEATHER_DOCS, type Check } from "../api.js";
import { calleeName, isDiscarded, isFunctionNode, isLoopNode, plural, unparen } from "../util.js";

const docs = (code: string) => `${FEATHER_DOCS}#:~:text=${code}`;

export const GM1100 = defineCheck({
  meta: {
    code: "GM1100",
    name: "syntax-error",
    description: "Syntax Error",
    category: "syntax",
    defaultSeverity: "error",
    preset: "syntax",
    feather: true,
    docs: docs("GM1100"),
  },
  // Reported by the runner from parse errors.
  create: () => ({}),
});

function loopCheck(code: "GM1000" | "GM1001", keyword: "break" | "continue"): Check {
  return defineCheck({
    meta: {
      code,
      name: `no-${keyword}-outside-loop`,
      description: `No enclosing loop from which to ${keyword}.`,
      category: "syntax",
      defaultSeverity: "error",
      preset: "syntax",
      feather: true,
      docs: docs(code),
    },
    create(ctx) {
      const check = (node: AST.BreakStatement | AST.ContinueStatement) => {
        for (const a of ctx.fc.ancestors(node)) {
          if (isLoopNode(a)) return;
          if (keyword === "break" && a.type === "SwitchCase") return;
          if (isFunctionNode(a) || a.type === "Program") break;
        }
        ctx.report({ node, message: `No enclosing loop from which to ${keyword}.` });
      };
      return keyword === "break" ? { BreakStatement: check } : { ContinueStatement: check };
    },
  });
}

export const GM1000 = loopCheck("GM1000", "break");
export const GM1001 = loopCheck("GM1001", "continue");

export const GM1021 = defineCheck({
  meta: {
    code: "GM1021",
    name: "no-undefined-function",
    description: "The function or script does not exist.",
    category: "semantic",
    defaultSeverity: "error",
    preset: "recommended",
    feather: true,
    docs: docs("GM1021"),
  },
  create(ctx) {
    if (!ctx.checker.spec) return {}; // without the built-in list every built-in would look undefined
    return {
      CallExpression(node) {
        const callee = unparen(node.callee);
        if (callee.type !== "Identifier") return;
        const r = ctx.fc.resolve(callee);
        // Only bare names that resolved to nothing are reported; anything that
        // might be a method variable in an unknown context is left alone.
        if (r?.kind !== "self-member") return;
        if (r.self.kind === "unknown") return;
        if (ctx.checker.binding.unknownTargetWrites.has(callee.name)) return;
        if (r.self.kind === "object" && ctx.checker.objectIsDynamic(r.self.object)) return;
        ctx.report({ node: callee, message: `The function or script '${callee.name}' does not exist.` });
      },
    };
  },
});

function argumentCountMessage(name: string, sig: { minArgs: number; maxArgs: number }, given: number): { code: string; message: string } | null {
  if (given > sig.maxArgs) {
    return {
      code: "GM1019",
      message: `The function '${name}' takes no more than ${plural(sig.maxArgs, "argument")} but ${given} ${given === 1 ? "is" : "are"} provided.`,
    };
  }
  if (given < sig.minArgs) {
    return {
      code: "GM1020",
      message: `The function '${name}' takes no less than ${plural(sig.minArgs, "argument")} but ${given} ${given === 1 ? "is" : "are"} provided.`,
    };
  }
  return null;
}

function arityCheck(code: "GM1019" | "GM1020"): Check {
  return defineCheck({
    meta: {
      code,
      name: code === "GM1019" ? "too-many-arguments" : "too-few-arguments",
      description:
        code === "GM1019"
          ? "The function takes no more than N arguments but more are provided."
          : "The function takes no less than N arguments but fewer are provided.",
      category: "semantic",
      defaultSeverity: "error",
      preset: "recommended",
      feather: true,
      docs: docs(code),
    },
    create(ctx) {
      const check = (node: AST.CallExpression | AST.NewExpression) => {
        const name = calleeName(node);
        if (!name) return;
        const sig = ctx.fc.signatureOfCallee(unparen(node.callee));
        if (!sig) return;
        const m = argumentCountMessage(name, sig, node.arguments.length);
        if (m?.code === code) ctx.report({ node, message: m.message });
      };
      return { CallExpression: check, NewExpression: check };
    },
  });
}

export const GM1019 = arityCheck("GM1019");
export const GM1020 = arityCheck("GM1020");

export const GM1005 = defineCheck({
  meta: {
    code: "GM1005",
    name: "missing-argument",
    description: "Argument must be provided.",
    category: "semantic",
    defaultSeverity: "error",
    preset: "recommended",
    feather: true,
    docs: docs("GM1005"),
  },
  create(ctx) {
    return {
      CallExpression(node) {
        const sig = ctx.fc.signatureOfCallee(unparen(node.callee));
        if (!sig) return;
        node.arguments.forEach((arg, i) => {
          if (arg !== null) return;
          const p = sig.parameters[i];
          // An omitted argument has no node, so report the call.
          if (p && !p.optional && !p.rest) ctx.report({ range: node.range, message: `Argument '${p.name}' must be provided.` });
        });
      },
    };
  },
});

export const GM2022 = defineCheck({
  meta: {
    code: "GM2022",
    name: "unused-pure-result",
    description: "Return value of a pure function is not being used.",
    category: "semantic",
    defaultSeverity: "warning",
    preset: "recommended",
    feather: true,
    docs: docs("GM2022"),
  },
  create(ctx) {
    return {
      CallExpression(node) {
        if (!isDiscarded(ctx.fc, node)) return;
        const sig = ctx.fc.signatureOfCallee(unparen(node.callee));
        if (!sig?.pure) return;
        const name = calleeName(node) ?? ctx.getText(node.callee);
        ctx.report({ node, message: `Return value of the pure function '${name}' is not being used.` });
      },
    };
  },
});

export const GM1013 = defineCheck({
  meta: {
    code: "GM1013",
    name: "no-undeclared-variable",
    description: "Reference to variable which has not been previously declared.",
    category: "semantic",
    defaultSeverity: "warning",
    preset: "strict",
    feather: true,
    docs: docs("GM1013"),
  },
  create(ctx) {
    const c = ctx.checker;
    const unsure = (name: string, object: string | null) =>
      c.binding.unknownTargetWrites.has(name) || (object !== null && c.objectIsDynamic(object));

    /** Is the identifier being declared by a plain assignment (`name = value`)? */
    const isDeclaringWrite = (id: AST.Node): boolean => {
      const p = ctx.fc.parent(id);
      return p?.type === "AssignmentExpression" && p.left === id && (p.operator === "=" || p.operator === ":=" || p.operator === "??=");
    };

    return {
      Identifier(node) {
        const r = ctx.fc.resolve(node);
        if (r?.kind !== "self-member" || isDeclaringWrite(node)) return;
        const p = ctx.fc.parent(node);
        if (p?.type === "CallExpression" && p.callee === node) return; // GM1021's job
        if (r.self.kind === "object") {
          if (unsure(node.name, r.self.object)) return;
          ctx.report({ node, message: `Reference to variable '${node.name}' which has not been previously declared in '${r.self.object}'.` });
        } else if (r.self.kind === "struct" && r.self.ctor && c.binding.constructors.has(r.self.ctor)) {
          if (unsure(node.name, null)) return;
          ctx.report({ node, message: `Reference to variable '${node.name}' which has not been previously declared in '${r.self.ctor}'.` });
        }
      },
      MemberExpression(node) {
        if (isDeclaringWrite(node)) return;
        const m = ctx.fc.resolveMember(node);
        if (m.kind !== "undeclared" || m.owner === "enum") return;
        if (unsure(m.name, m.owner === "object" ? m.ownerName : null)) return;
        ctx.report({ node: node.property, message: `Reference to variable '${m.name}' which has not been previously declared in '${m.ownerName}'.` });
      },
    };
  },
});

export const GM1014 = defineCheck({
  meta: {
    code: "GM1014",
    name: "no-undefined-enum-member",
    description: "The enum does not contain the value.",
    category: "semantic",
    defaultSeverity: "error",
    preset: "recommended",
    feather: true,
    docs: docs("GM1014"),
  },
  create(ctx) {
    return {
      MemberExpression(node) {
        const m = ctx.fc.resolveMember(node);
        if (m.kind === "undeclared" && m.owner === "enum") {
          ctx.report({ node: node.property, message: `The enum '${m.ownerName}' does not contain the value '${m.name}'.` });
        }
      },
    };
  },
});

export const coreChecks: Check[] = [GM1100, GM1000, GM1001, GM1005, GM1013, GM1014, GM1019, GM1020, GM1021, GM2022];
