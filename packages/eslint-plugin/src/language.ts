/**
 * The `gml/gml` ESLint language: parsing, SourceCode, traversal, and inline
 * `eslint-disable` comments for GML files.
 */

import { ConfigCommentParser, Directive, TextSourceCodeBase, VisitNodeStep } from "@eslint/plugin-kit";
import type { Checker, FileChecker, Program, SourceFile } from "@gml-lint/checker";
import { childNodes, visitorKeys, type Comment, type Node, type Program as AST_Program } from "@gml-lint/parser";
import { getProgramForFile, type GmlLanguageOptions } from "./programs.js";

export interface GmlParserServices {
  program: Program;
  checker: Checker;
  sourceFile: SourceFile;
  /** Per-file queries: resolve(), typeOf(), selfAt(), scopeOf(), parent()... */
  fc: FileChecker;
}

interface File {
  path: string;
  physicalPath?: string;
  body: string | Uint8Array;
}

interface ParseContext {
  languageOptions: GmlLanguageOptions;
}

const commentParser = new ConfigCommentParser();
const INLINE_CONFIG = /^\s*(?:eslint(?:-enable|-disable(?:(?:-next)?-line)?)?|global)(?:\s|$)/u;

class GmlTraversalStep extends VisitNodeStep {
  declare target: Node;
}

export class GmlSourceCode extends TextSourceCodeBase {
  declare ast: AST_Program;
  readonly comments: Comment[];
  readonly parserServices: GmlParserServices;
  private steps: GmlTraversalStep[] | undefined;
  private readonly parents = new WeakMap<Node, Node>();
  private inlineConfigComments: Comment[] | undefined;

  constructor({ text, ast, parserServices }: { text: string; ast: AST_Program; parserServices: GmlParserServices }) {
    super({ text, ast, lineEndingPattern: /\r\n|[\r\n]/u });
    this.ast = ast;
    this.comments = ast.comments;
    this.parserServices = parserServices;
  }

  override getParent(node: Node): Node | undefined {
    if (!this.steps) this.traverse();
    return this.parents.get(node);
  }

  override traverse(): Iterable<GmlTraversalStep> {
    if (this.steps) return this.steps.values();
    const steps: GmlTraversalStep[] = (this.steps = []);
    const visit = (node: Node, parent: Node | undefined): void => {
      if (parent) this.parents.set(node, parent);
      steps.push(new GmlTraversalStep({ target: node, phase: 1, args: [node, parent] }));
      for (const child of childNodes(node)) visit(child, node);
      steps.push(new GmlTraversalStep({ target: node, phase: 2, args: [node, parent] }));
    };
    visit(this.ast, undefined);
    return steps.values();
  }

  getInlineConfigNodes(): Comment[] {
    this.inlineConfigComments ??= this.comments.filter((c) => INLINE_CONFIG.test(c.value));
    return this.inlineConfigComments;
  }

  getDisableDirectives(): { problems: Array<{ ruleId: null; message: string; loc: Comment["loc"] }>; directives: Directive[] } {
    const problems: Array<{ ruleId: null; message: string; loc: Comment["loc"] }> = [];
    const directives: Directive[] = [];
    for (const comment of this.getInlineConfigNodes()) {
      const { label, value, justification } = commentParser.parseDirective(comment.value) ?? {};
      if (!label) continue;
      if (label === "eslint-disable-line" && comment.loc.start.line !== comment.loc.end.line) {
        problems.push({ ruleId: null, message: `${label} comment should not span multiple lines.`, loc: comment.loc });
        continue;
      }
      switch (label) {
        case "eslint-disable":
        case "eslint-enable":
        case "eslint-disable-next-line":
        case "eslint-disable-line":
          directives.push(
            new Directive({
              type: label.slice("eslint-".length) as "disable" | "enable" | "disable-next-line" | "disable-line",
              node: comment,
              value: value ?? "",
              justification: justification ?? "",
            }),
          );
      }
    }
    return { problems, directives };
  }

  applyInlineConfig(): {
    configs: Array<{ config: { rules: Record<string, unknown> }; loc: Comment["loc"] }>;
    problems: Array<{ ruleId: null; message: string; loc: Comment["loc"] }>;
  } {
    const configs: Array<{ config: { rules: Record<string, unknown> }; loc: Comment["loc"] }> = [];
    const problems: Array<{ ruleId: null; message: string; loc: Comment["loc"] }> = [];
    for (const comment of this.getInlineConfigNodes()) {
      const { label, value } = commentParser.parseDirective(comment.value) ?? {};
      if (label !== "eslint") continue;
      const r = commentParser.parseJSONLikeConfig(value ?? "");
      if (r.ok) configs.push({ config: { rules: r.config as Record<string, unknown> }, loc: comment.loc });
      else problems.push({ ruleId: null, message: r.error.message, loc: comment.loc });
    }
    return { configs, problems };
  }
}

export class GmlLanguage {
  fileType = "text" as const;
  lineStart = 1 as const;
  columnStart = 0 as const;
  nodeTypeKey = "type";
  visitorKeys: Record<string, string[]> = Object.fromEntries(Object.entries(visitorKeys).map(([k, v]) => [k, [...v]]));
  defaultLanguageOptions: GmlLanguageOptions = { project: "auto" };

  validateLanguageOptions(options: GmlLanguageOptions): void {
    if (options.project !== undefined && options.project !== false && typeof options.project !== "string") {
      throw new Error("languageOptions.project must be a path, \"auto\" or false.");
    }
    if (options.spec !== undefined && typeof options.spec !== "string") throw new Error("languageOptions.spec must be a path to GmlSpec.xml.");
  }

  parse(file: File, context: ParseContext): { ok: true; ast: AST_Program; services: GmlParserServices } {
    const text = typeof file.body === "string" ? file.body : new TextDecoder().decode(file.body);
    const filename = file.physicalPath ?? file.path;
    const { program, sourceFile } = getProgramForFile(filename, text, context.languageOptions ?? {});
    const checker = program.getChecker();
    // GML parsing never fails outright; syntax errors are reported by gml/syntax-error.
    return {
      ok: true,
      ast: sourceFile.ast,
      services: { program, checker, sourceFile, fc: checker.forFile(sourceFile) },
    };
  }

  createSourceCode(file: File, parseResult: { ast: AST_Program; services: GmlParserServices }): GmlSourceCode {
    const text = typeof file.body === "string" ? file.body : new TextDecoder().decode(file.body);
    return new GmlSourceCode({ text, ast: parseResult.ast, parserServices: parseResult.services });
  }
}

export const gmlLanguage = new GmlLanguage();
