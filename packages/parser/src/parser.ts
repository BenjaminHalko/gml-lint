/**
 * Error-tolerant recursive-descent parser for GML.
 *
 * - Never throws on bad input: problems are collected as ParseErrors and the
 *   parser resynchronises at the next statement boundary.
 * - Operator precedence mirrors the GameMaker compiler (bitwise binds tighter
 *   than comparison; `^^` tighter than `&&` tighter than `||`; then `??`, `?:`).
 * - `=` is assignment at statement level and equality inside expressions.
 */

import type * as AST from "./ast.js";
import { lex, type LexToken } from "./lexer.js";
import { LineMap } from "./line-map.js";
import { traverse } from "./visitor-keys.js";

export interface ParseError {
  message: string;
  range: AST.Range;
  loc: AST.SourceLocation;
}

export interface ParseOptions {
  /** Parse only `text.slice(start, end)`; ranges stay absolute. */
  start?: number;
  end?: number;
  /** Re-use an existing line map for `text`. */
  lineMap?: LineMap;
}

export interface ParseResult {
  ast: AST.Program;
  errors: ParseError[];
  lineMap: LineMap;
}

type Directive = AST.MacroDeclaration | AST.RegionDirective | AST.DefineDirective;

const ASSIGNMENT_OPERATORS: ReadonlySet<string> = new Set([
  "=", ":=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", "??=",
]);

/** Binary precedence (higher binds tighter). `?:` is handled separately. */
const BINARY_PRECEDENCE: Readonly<Record<string, number>> = {
  "??": 1,
  "||": 2, or: 2,
  "&&": 3, and: 3,
  "^^": 4, xor: 4,
  "==": 5, "=": 5, "!=": 5, "<>": 5, "<": 5, "<=": 5, ">": 5, ">=": 5,
  "&": 6, "|": 6, "^": 6,
  "<<": 7, ">>": 7,
  "+": 8, "-": 8,
  "*": 9, "/": 9, "%": 9, mod: 9, div: 9,
};

const LOGICAL = new Set(["??", "||", "or", "&&", "and", "^^", "xor"]);

/** Keywords that start a statement; used to resynchronise after errors. */
const STATEMENT_KEYWORDS = new Set([
  "var", "globalvar", "static", "if", "while", "do", "repeat", "for", "with", "switch",
  "break", "continue", "exit", "return", "function", "enum", "try", "throw", "delete",
]);

export function parse(text: string, options: ParseOptions = {}): ParseResult {
  const lineMap = options.lineMap ?? new LineMap(text);
  const start = options.start ?? 0;
  const end = options.end ?? text.length;
  const p = new Parser(text, lineMap, start, end);
  const ast = p.parseProgram();
  return { ast, errors: p.errors, lineMap };
}

/** Parses a standalone expression (e.g. a macro body). */
export function parseExpression(
  text: string,
  options: ParseOptions = {},
): { expression: AST.Expression | null; errors: ParseError[] } {
  const lineMap = options.lineMap ?? new LineMap(text);
  const p = new Parser(text, lineMap, options.start ?? 0, options.end ?? text.length);
  return p.parseStandaloneExpression();
}

class Parser {
  readonly errors: ParseError[] = [];
  private readonly tokens: LexToken[];
  private readonly directives: Directive[] = [];
  private readonly comments: AST.Comment[];
  private index = 0;
  private readonly text: string;
  private readonly lineMap: LineMap;
  private readonly start: number;
  private readonly end: number;

  constructor(text: string, lineMap: LineMap, start: number, end: number) {
    this.text = text;
    this.lineMap = lineMap;
    this.start = start;
    this.end = end;
    const lexed = lex(text, start, end);
    for (const d of lexed.diagnostics) this.errorAt(d.message, d.start, d.end);
    this.comments = lexed.comments.map((c) => ({
      type: c.type,
      value: c.value,
      range: [c.start, c.end] as AST.Range,
      loc: lineMap.loc([c.start, c.end]),
    }));
    // Directives live outside the token stream so they can appear anywhere.
    const tokens: LexToken[] = [];
    for (const t of lexed.tokens) {
      if (t.kind === "Directive") this.directives.push(this.directiveNode(t));
      else tokens.push(t);
    }
    this.tokens = tokens;
  }

  // -------------------------------------------------------------------------
  // Cursor helpers
  // -------------------------------------------------------------------------

  private get tok(): LexToken {
    return this.tokens[this.index]!;
  }

  private peek(): LexToken {
    return this.tokens[Math.min(this.index + 1, this.tokens.length - 1)]!;
  }

  private get prevEnd(): number {
    return this.index > 0 ? this.tokens[this.index - 1]!.end : this.start;
  }

  private advance(): LexToken {
    const t = this.tok;
    if (t.kind !== "EOF") this.index++;
    return t;
  }

  private is(value: string, t: LexToken = this.tok): boolean {
    return (t.kind === "Punctuator" || t.kind === "Keyword") && t.value === value;
  }

  private eat(value: string): boolean {
    if (this.is(value)) {
      this.advance();
      return true;
    }
    return false;
  }

  private expect(value: string, context?: string): boolean {
    if (this.eat(value)) return true;
    this.error(`Expected '${value}'${context ? ` ${context}` : ""} but found ${describe(this.tok)}`);
    return false;
  }

  private get atEOF(): boolean {
    return this.tok.kind === "EOF";
  }

  private error(message: string, token: LexToken = this.tok): void {
    this.errorAt(message, token.start, token.end);
  }

  private errorAt(message: string, start: number, end: number): void {
    const last = this.errors[this.errors.length - 1];
    // Collapse cascades at the same position
    if (last && last.range[0] === start) return;
    this.errors.push({ message, range: [start, end], loc: this.lineMap.loc([start, end]) });
  }

  private finish<T extends AST.BaseNode>(node: Omit<T, "range" | "loc">, start: number, end = this.prevEnd): T {
    const range: AST.Range = [start, Math.max(start, end)];
    return { ...node, range, loc: this.lineMap.loc(range) } as T;
  }

  private identifierFrom(t: LexToken): AST.Identifier {
    return this.finish<AST.Identifier>({ type: "Identifier", name: t.value }, t.start, t.end);
  }

  /** Number or String token. */
  private literalFrom(t: LexToken): AST.Literal {
    const { kind, value } = t.literal!;
    return this.finish<AST.Literal>({ type: "Literal", kind, value, raw: t.value }, t.start, t.end);
  }

  // -------------------------------------------------------------------------
  // Program
  // -------------------------------------------------------------------------

  parseProgram(): AST.Program {
    const body: AST.Statement[] = [];
    while (!this.atEOF) this.parseStatementInto(body);
    const program = this.finish<AST.Program>(
      {
        type: "Program",
        body,
        comments: this.comments,
        tokens: this.tokens
          .filter((t) => t.kind !== "EOF")
          .map((t) => ({
            type: t.kind === "Number" ? "Numeric" : t.kind === "Invalid" ? "Punctuator" : t.kind,
            value: t.value,
            range: [t.start, t.end] as AST.Range,
            loc: this.lineMap.loc([t.start, t.end]),
          })) as AST.Token[],
      },
      this.start,
      this.end,
    );
    insertDirectives(program, this.directives);
    return program;
  }

  parseStandaloneExpression(): { expression: AST.Expression | null; errors: ParseError[] } {
    if (this.atEOF) return { expression: null, errors: this.errors };
    const expression = this.parseExpression();
    if (!this.atEOF) this.error(`Unexpected ${describe(this.tok)} after expression`);
    return { expression, errors: this.errors };
  }

  // -------------------------------------------------------------------------
  // Directives
  // -------------------------------------------------------------------------

  private directiveNode(t: LexToken): Directive {
    const d = t.directive!;
    if (d.name === "macro") {
      const name = d.macroName!;
      const body = d.body!;
      let expression: AST.Expression | null = null;
      if (body.text.trim() !== "" && !/[\r\n]/.test(body.text)) {
        const sub = new Parser(this.text, this.lineMap, body.range[0], body.range[0] + body.text.length);
        const r = sub.parseStandaloneExpression();
        if (r.errors.length === 0) expression = r.expression;
      }
      return this.finish<AST.MacroDeclaration>(
        {
          type: "MacroDeclaration",
          id: this.finish<AST.Identifier>({ type: "Identifier", name: name.text }, name.range[0], name.range[1]),
          config: d.macroConfig
            ? this.finish<AST.Identifier>({ type: "Identifier", name: d.macroConfig.text }, d.macroConfig.range[0], d.macroConfig.range[1])
            : null,
          value: body.text,
          valueRange: [body.range[0], body.range[0] + body.text.length],
          expression,
        },
        t.start,
        t.end,
      );
    }
    if (d.name === "define") {
      return this.finish<AST.DefineDirective>({ type: "DefineDirective", name: d.argument ?? "" }, t.start, t.end);
    }
    return this.finish<AST.RegionDirective>(
      { type: "RegionDirective", kind: d.name, name: d.argument ?? "" },
      t.start,
      t.end,
    );
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  private parseStatement(): AST.Statement | null {
    const t = this.tok;

    if (t.kind === "Punctuator") {
      switch (t.value) {
        case "{":
          return this.parseBlock();
        case ";":
          this.advance();
          return this.finish<AST.EmptyStatement>({ type: "EmptyStatement" }, t.start);
        case "}":
          return null; // caller decides
      }
    }

    if (t.kind === "Keyword") {
      switch (t.value) {
        case "begin":
          return this.parseBlock();
        case "var":
        case "globalvar":
        case "static":
          return this.parseVariableDeclaration(t.value);
        case "if":
          return this.parseIf();
        case "while":
          return this.parseWhile();
        case "do":
          return this.parseDoUntil();
        case "repeat":
          return this.parseRepeat();
        case "for":
          return this.parseFor();
        case "with":
          return this.parseWith();
        case "switch":
          return this.parseSwitch();
        case "break":
          this.advance();
          this.eat(";");
          return this.finish<AST.BreakStatement>({ type: "BreakStatement" }, t.start);
        case "continue":
          this.advance();
          this.eat(";");
          return this.finish<AST.ContinueStatement>({ type: "ContinueStatement" }, t.start);
        case "exit":
          this.advance();
          this.eat(";");
          return this.finish<AST.ExitStatement>({ type: "ExitStatement" }, t.start);
        case "return":
          return this.parseReturn();
        case "throw": {
          this.advance();
          const argument = this.parseExpression();
          this.eat(";");
          return this.finish<AST.ThrowStatement>({ type: "ThrowStatement", argument }, t.start);
        }
        case "delete": {
          this.advance();
          const argument = this.parseExpression();
          this.eat(";");
          return this.finish<AST.DeleteStatement>({ type: "DeleteStatement", argument }, t.start);
        }
        case "try":
          return this.parseTry();
        case "enum":
          return this.parseEnum();
        case "function":
          if (this.peek().kind === "Identifier") return this.parseFunctionDeclaration();
          break;
        case "case":
        case "default":
        case "else":
        case "until":
        case "catch":
        case "finally":
        case "then":
        case "end":
        case "constructor":
          return this.invalidStatement(`Unexpected '${t.value}'`);
      }
    }

    if (t.kind === "EOF") return null;
    return this.parseExpressionStatement();
  }

  /** Parses one statement into `list`; skips a token when none could be parsed (e.g. a stray `}`). */
  private parseStatementInto(list: AST.Statement[]): void {
    const before = this.index;
    const stmt = this.parseStatement();
    if (stmt) list.push(stmt);
    if (this.index === before) {
      const t = this.advance();
      this.error(`Unexpected ${describe(t)}`, t);
    }
  }

  /** Parses a statement that must exist (loop/if bodies). */
  private parseBody(context: string): AST.Statement {
    const stmt = this.parseStatement();
    if (stmt) return stmt;
    this.error(`Expected a statement ${context}`);
    return this.finish<AST.InvalidStatement>({ type: "InvalidStatement" }, this.tok.start, this.tok.start);
  }

  private invalidStatement(message: string): AST.InvalidStatement {
    const start = this.tok.start;
    this.error(message);
    this.advance();
    this.synchronize();
    return this.finish<AST.InvalidStatement>({ type: "InvalidStatement" }, start);
  }

  /** Skips tokens until a plausible statement boundary. */
  private synchronize(): void {
    while (!this.atEOF) {
      const t = this.tok;
      if (this.is(";")) {
        this.advance();
        return;
      }
      if (this.is("}") || this.is("{")) return;
      if (t.newlineBefore && (t.kind === "Identifier" || (t.kind === "Keyword" && STATEMENT_KEYWORDS.has(t.value)))) return;
      if (t.kind === "Keyword" && (t.value === "case" || t.value === "default")) return;
      this.advance();
    }
  }

  private parseBlock(): AST.BlockStatement {
    const open = this.advance();
    const style = open.value === "begin" ? "begin-end" : "braces";
    const close = style === "braces" ? "}" : "end";
    const body: AST.Statement[] = [];
    while (!this.atEOF && !this.is(close)) {
      if (style === "begin-end" && this.is("}")) break;
      this.parseStatementInto(body);
    }
    if (!this.eat(close)) this.errorAt(`Expected '${close}' to close the block opened here`, open.start, open.end);
    return this.finish<AST.BlockStatement>({ type: "BlockStatement", body, style }, open.start);
  }

  private parseRequiredBlock(context: string): AST.BlockStatement {
    if (this.is("{") || this.is("begin")) return this.parseBlock();
    this.error(`Expected '{' ${context}`);
    const at = this.tok.start;
    return this.finish<AST.BlockStatement>({ type: "BlockStatement", body: [], style: "braces" }, at, at);
  }

  private parseVariableDeclaration(kind: "var" | "globalvar" | "static"): AST.VariableDeclaration {
    const start = this.advance().start;
    const declarations: AST.VariableDeclarator[] = [];
    do {
      const t = this.tok;
      if (t.kind !== "Identifier") {
        this.error(`Expected a variable name after '${kind}'`);
        break;
      }
      this.advance();
      const id = this.identifierFrom(t);
      let init: AST.Expression | null = null;
      if (this.is("=") || this.is(":=")) {
        this.advance();
        init = this.parseExpression();
      }
      declarations.push(this.finish<AST.VariableDeclarator>({ type: "VariableDeclarator", id, init }, t.start));
    } while (this.eat(","));
    const semicolon = this.eat(";");
    return this.finish<AST.VariableDeclaration>({ type: "VariableDeclaration", kind, declarations, semicolon }, start);
  }

  private parseIf(): AST.IfStatement {
    const start = this.advance().start;
    const test = this.parseExpression();
    const then = this.eat("then");
    const consequent = this.parseBody("after 'if' condition");
    let alternate: AST.Statement | null = null;
    // GML allows `if (x) a = 1; else b = 1;` with the `;` already consumed
    if (this.eat("else")) alternate = this.parseBody("after 'else'");
    return this.finish<AST.IfStatement>({ type: "IfStatement", test, consequent, alternate, then }, start);
  }

  private parseWhile(): AST.WhileStatement {
    const start = this.advance().start;
    const test = this.parseExpression();
    this.eat("do");
    const body = this.parseBody("after 'while' condition");
    return this.finish<AST.WhileStatement>({ type: "WhileStatement", test, body }, start);
  }

  private parseDoUntil(): AST.DoUntilStatement {
    const start = this.advance().start;
    const body = this.parseBody("after 'do'");
    let test: AST.Expression;
    if (this.eat("until")) {
      test = this.parseExpression();
    } else {
      this.error("Expected 'until' after 'do' body");
      test = this.invalidExpression();
    }
    this.eat(";");
    return this.finish<AST.DoUntilStatement>({ type: "DoUntilStatement", body, test }, start);
  }

  private parseRepeat(): AST.RepeatStatement {
    const start = this.advance().start;
    const count = this.parseExpression();
    const body = this.parseBody("after 'repeat' count");
    return this.finish<AST.RepeatStatement>({ type: "RepeatStatement", count, body }, start);
  }

  private parseFor(): AST.ForStatement {
    const start = this.advance().start;
    this.expect("(", "after 'for'");
    let init: AST.VariableDeclaration | AST.ExpressionStatement | null = null;
    if (this.is("var")) {
      init = this.parseVariableDeclaration("var");
    } else if (!this.eat(";")) {
      init = this.parseExpressionStatement(true);
      if (!init.semicolon) this.expect(";", "after 'for' initializer");
    }
    let test: AST.Expression | null = null;
    if (!this.is(";")) test = this.parseExpression();
    this.expect(";", "after 'for' condition");
    let update: AST.ExpressionStatement | null = null;
    if (!this.is(")")) update = this.parseExpressionStatement(true, true);
    this.eat(";"); // `for (i = 0; i < n; i++;)` compiles in GameMaker
    this.expect(")", "to close 'for'");
    const body = this.parseBody("after 'for' header");
    return this.finish<AST.ForStatement>({ type: "ForStatement", init, test, update, body }, start);
  }

  private parseWith(): AST.WithStatement {
    const start = this.advance().start;
    const object = this.parseExpression();
    const body = this.parseBody("after 'with' target");
    return this.finish<AST.WithStatement>({ type: "WithStatement", object, body }, start);
  }

  private parseSwitch(): AST.SwitchStatement {
    const start = this.advance().start;
    const discriminant = this.parseExpression();
    const cases: AST.SwitchCase[] = [];
    const open = this.tok;
    const close = this.is("begin") ? "end" : "}";
    if (!this.eat("{") && !this.eat("begin")) {
      this.error("Expected '{' after 'switch' value");
      return this.finish<AST.SwitchStatement>({ type: "SwitchStatement", discriminant, cases }, start);
    }
    while (!this.atEOF && !this.is(close)) {
      const t = this.tok;
      if (this.is("case") || this.is("default")) {
        this.advance();
        const test = t.value === "case" ? this.parseExpression() : null;
        if (!this.eat(":") && !this.eat(";")) this.error(`Expected ':' after '${t.value}' but found ${describe(this.tok)}`);
        const consequent: AST.Statement[] = [];
        while (!this.atEOF && !this.is("case") && !this.is("default") && !this.is(close)) {
          this.parseStatementInto(consequent);
        }
        cases.push(this.finish<AST.SwitchCase>({ type: "SwitchCase", test, consequent }, t.start));
      } else {
        // Statements before the first case are invalid in GML
        const before = this.index;
        this.error("Expected 'case' or 'default' in switch");
        this.parseStatement();
        if (this.index === before) this.advance();
      }
    }
    if (!this.eat(close)) this.errorAt(`Expected '${close}' to close the switch`, open.start, open.end);
    return this.finish<AST.SwitchStatement>({ type: "SwitchStatement", discriminant, cases }, start);
  }

  private parseReturn(): AST.ReturnStatement {
    const t = this.advance();
    let argument: AST.Expression | null = null;
    if (!this.is(";") && !this.is("}") && !this.atEOF && this.startsExpression(this.tok) && !(this.tok.newlineBefore && this.startsStatementKeyword(this.tok))) {
      argument = this.parseExpression();
    }
    this.eat(";");
    return this.finish<AST.ReturnStatement>({ type: "ReturnStatement", argument }, t.start);
  }

  private parseTry(): AST.TryStatement {
    const start = this.advance().start;
    const block = this.parseRequiredBlock("after 'try'");
    let handler: AST.CatchClause | null = null;
    let finalizer: AST.BlockStatement | null = null;
    if (this.is("catch")) {
      const c = this.advance();
      let param: AST.Identifier | null = null;
      if (this.eat("(")) {
        if (this.tok.kind === "Identifier") param = this.identifierFrom(this.advance());
        this.expect(")", "after catch parameter");
      } else if (this.tok.kind === "Identifier") {
        param = this.identifierFrom(this.advance());
      }
      const body = this.parseRequiredBlock("after 'catch'");
      handler = this.finish<AST.CatchClause>({ type: "CatchClause", param, body }, c.start);
    }
    if (this.eat("finally")) finalizer = this.parseRequiredBlock("after 'finally'");
    if (!handler && !finalizer) this.error("Expected 'catch' or 'finally' after 'try' block");
    return this.finish<AST.TryStatement>({ type: "TryStatement", block, handler, finalizer }, start);
  }

  private parseEnum(): AST.EnumDeclaration {
    const start = this.advance().start;
    let id: AST.Identifier;
    if (this.tok.kind === "Identifier") id = this.identifierFrom(this.advance());
    else {
      this.error("Expected an enum name");
      id = this.finish<AST.Identifier>({ type: "Identifier", name: "" }, this.tok.start, this.tok.start);
    }
    const members: AST.EnumMember[] = [];
    if (this.expect("{", "after enum name")) {
      while (!this.atEOF && !this.is("}")) {
        const t = this.tok;
        if (t.kind !== "Identifier" && t.kind !== "Keyword") {
          this.error("Expected an enum member name");
          this.advance();
          continue;
        }
        this.advance();
        let initializer: AST.Expression | null = null;
        if (this.eat("=")) initializer = this.parseExpression();
        members.push(this.finish<AST.EnumMember>({ type: "EnumMember", id: this.identifierFrom(t), initializer }, t.start));
        if (!this.eat(",")) break;
      }
      this.expect("}", "to close the enum");
    }
    this.eat(";");
    return this.finish<AST.EnumDeclaration>({ type: "EnumDeclaration", id, members }, start);
  }

  private parseFunctionDeclaration(): AST.FunctionDeclaration {
    const start = this.advance().start;
    const id = this.identifierFrom(this.advance());
    const rest = this.parseFunctionRest();
    this.eat(";");
    return this.finish<AST.FunctionDeclaration>({ type: "FunctionDeclaration", id, ...rest }, start);
  }

  private parseFunctionRest(): Pick<AST.FunctionDeclaration, "params" | "body" | "isConstructor" | "parent"> {
    const params: AST.Parameter[] = [];
    if (this.expect("(", "to start the parameter list")) {
      while (!this.atEOF && !this.is(")")) {
        const t = this.tok;
        if (t.kind !== "Identifier") {
          this.error("Expected a parameter name");
          if (this.is(",")) {
            this.advance();
            continue;
          }
          break;
        }
        this.advance();
        let init: AST.Expression | null = null;
        if (this.eat("=")) init = this.parseExpression();
        params.push(this.finish<AST.Parameter>({ type: "Parameter", id: this.identifierFrom(t), init }, t.start));
        if (!this.eat(",")) break;
      }
      this.expect(")", "to close the parameter list");
    }
    let parent: AST.ConstructorParent | null = null;
    if (this.is(":")) {
      const colon = this.advance();
      if (this.tok.kind === "Identifier") {
        const calleeTok = this.advance();
        const args = this.is("(") ? this.parseArguments() : [];
        parent = this.finish<AST.ConstructorParent>(
          { type: "ConstructorParent", callee: this.identifierFrom(calleeTok), arguments: args },
          calleeTok.start,
        );
      } else {
        this.error("Expected a parent constructor name after ':'", colon);
      }
    }
    const isConstructor = this.eat("constructor");
    const body = this.parseRequiredBlock("to start the function body");
    return { params, body, isConstructor, parent };
  }

  private parseExpressionStatement(inForHeader = false, isUpdate = false): AST.ExpressionStatement {
    const start = this.tok.start;
    const left = this.parseUnary();
    let expression: AST.Expression | AST.AssignmentExpression;
    if (this.tok.kind === "Punctuator" && ASSIGNMENT_OPERATORS.has(this.tok.value)) {
      const op = this.advance().value as AST.AssignmentOperator;
      const right = this.parseExpression();
      expression = this.finish<AST.AssignmentExpression>({ type: "AssignmentExpression", operator: op, left, right }, start);
    } else {
      expression = this.parseConditionalRest(this.parseBinaryRest(left, 0, start), start);
    }
    const semicolon = isUpdate ? false : this.eat(";");
    if (!inForHeader && !semicolon) this.checkStatementEnd();
    return this.finish<AST.ExpressionStatement>({ type: "ExpressionStatement", expression, semicolon }, start);
  }

  /** After a statement without `;`, the next token should begin a new statement. */
  private checkStatementEnd(): void {
    const t = this.tok;
    if (t.kind === "EOF" || t.newlineBefore || this.is("}") || this.is("end")) return;
    if (t.kind === "Keyword" && (STATEMENT_KEYWORDS.has(t.value) || ["else", "case", "default", "until", "catch", "finally"].includes(t.value))) return;
    if (t.kind === "Identifier" || this.is("{") || this.is("++") || this.is("--")) return; // `a = 1 b = 2` is legal GML
    this.error(`Unexpected ${describe(t)}; expected the end of the statement`);
    this.synchronize();
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  private parseExpression(): AST.Expression {
    const start = this.tok.start;
    return this.parseConditionalRest(this.parseBinaryRest(this.parseUnary(), 0, start), start);
  }

  private parseConditionalRest(test: AST.Expression, start: number): AST.Expression {
    if (!this.is("?")) return test;
    this.advance();
    const consequent = this.parseExpression();
    this.expect(":", "in conditional expression");
    const alternate = this.parseExpression();
    return this.finish<AST.ConditionalExpression>({ type: "ConditionalExpression", test, consequent, alternate }, start);
  }

  /** Precedence climbing, continuing from an already-parsed left operand. */
  private parseBinaryRest(left: AST.Expression, minPrec: number, start: number): AST.Expression {
    while (true) {
      const t = this.tok;
      if (t.kind !== "Punctuator" && t.kind !== "Keyword") return left;
      const prec = BINARY_PRECEDENCE[t.value];
      if (prec === undefined || prec <= minPrec) return left;
      this.advance();
      const rightStart = this.tok.start;
      let right = this.parseUnary();
      // Bind tighter operators to the right operand
      while (true) {
        const n = this.tok;
        if (n.kind !== "Punctuator" && n.kind !== "Keyword") break;
        const nPrec = BINARY_PRECEDENCE[n.value];
        if (nPrec === undefined || nPrec <= prec) break;
        right = this.parseBinaryRest(right, prec, rightStart);
      }
      left = LOGICAL.has(t.value)
        ? this.finish<AST.LogicalExpression>(
            { type: "LogicalExpression", operator: t.value as AST.LogicalOperator, left, right },
            start,
          )
        : this.finish<AST.BinaryExpression>(
            { type: "BinaryExpression", operator: t.value as AST.BinaryOperator, left, right },
            start,
          );
    }
  }

  private parseUnary(): AST.Expression {
    const t = this.tok;
    if (t.kind === "Punctuator" && (t.value === "!" || t.value === "-" || t.value === "+" || t.value === "~")) {
      this.advance();
      const argument = this.parseUnary();
      return this.finish<AST.UnaryExpression>({ type: "UnaryExpression", operator: t.value, argument }, t.start);
    }
    if (t.kind === "Keyword" && t.value === "not") {
      this.advance();
      const argument = this.parseUnary();
      return this.finish<AST.UnaryExpression>({ type: "UnaryExpression", operator: "not", argument }, t.start);
    }
    if (t.kind === "Punctuator" && (t.value === "++" || t.value === "--")) {
      this.advance();
      const argument = this.parseUnary();
      return this.finish<AST.UpdateExpression>({ type: "UpdateExpression", operator: t.value, prefix: true, argument }, t.start);
    }
    return this.parsePostfix(this.parsePrimary());
  }

  private parsePostfix(expr: AST.Expression, allowCalls = true): AST.Expression {
    const start = expr.range[0];
    while (true) {
      const t = this.tok;
      if (t.kind !== "Punctuator") return expr;
      if (t.value === ".") {
        this.advance();
        const name = this.tok;
        if (name.kind === "Identifier" || name.kind === "Keyword") {
          this.advance();
          expr = this.finish<AST.MemberExpression>(
            { type: "MemberExpression", object: expr, property: this.identifierFrom(name) },
            start,
          );
        } else {
          this.error("Expected a property name after '.'");
          expr = this.finish<AST.MemberExpression>(
            {
              type: "MemberExpression",
              object: expr,
              property: this.finish<AST.Identifier>({ type: "Identifier", name: "" }, t.end, t.end),
            },
            start,
          );
        }
      } else if (t.value === "(" && allowCalls) {
        const args = this.parseArguments();
        expr = this.finish<AST.CallExpression>({ type: "CallExpression", callee: expr, arguments: args }, start);
      } else if (t.value === "[" || (t.value.length === 2 && t.value[0] === "[")) {
        this.advance();
        const accessor = (t.value.length === 2 ? t.value[1] : "") as AST.Accessor;
        const indices: AST.Expression[] = [];
        if (!this.is("]")) {
          do indices.push(this.parseExpression());
          while (this.eat(","));
        }
        this.expect("]", "to close the accessor");
        expr = this.finish<AST.IndexExpression>({ type: "IndexExpression", object: expr, accessor, indices }, start);
      } else if ((t.value === "++" || t.value === "--") && !t.newlineBefore) {
        this.advance();
        expr = this.finish<AST.UpdateExpression>(
          { type: "UpdateExpression", operator: t.value, prefix: false, argument: expr },
          start,
        );
      } else {
        return expr;
      }
    }
  }

  private parseArguments(): Array<AST.Expression | null> {
    const open = this.advance(); // (
    const args: Array<AST.Expression | null> = [];
    if (this.eat(")")) return args;
    while (true) {
      if (this.is(",")) {
        args.push(null);
        this.advance();
        if (this.is(")")) break; // trailing comma
        continue;
      }
      if (this.is(")") || this.atEOF) break;
      args.push(this.parseExpression());
      if (!this.eat(",")) break;
      if (this.is(")")) break; // trailing comma
    }
    if (!this.eat(")")) this.errorAt("Expected ')' to close the argument list", open.start, open.end);
    return args;
  }

  private parsePrimary(): AST.Expression {
    const t = this.tok;
    switch (t.kind) {
      case "Identifier":
        this.advance();
        return this.identifierFrom(t);
      case "Number":
      case "String":
        this.advance();
        return this.literalFrom(t);
      case "Template":
        this.advance();
        return this.templateLiteral(t);
      case "Keyword":
        switch (t.value) {
          case "true":
          case "false":
            this.advance();
            return this.finish<AST.Literal>(
              { type: "Literal", kind: "boolean", value: t.value === "true", raw: t.value },
              t.start,
              t.end,
            );
          case "undefined":
            this.advance();
            return this.finish<AST.Literal>({ type: "Literal", kind: "undefined", value: null, raw: t.value }, t.start, t.end);
          case "function":
            return this.parseFunctionExpression();
          case "new":
            return this.parseNew();
        }
        break;
      case "Punctuator":
        switch (t.value) {
          case "(": {
            this.advance();
            const expression = this.parseExpression();
            this.expect(")", "to close the parenthesis");
            return this.finish<AST.ParenthesizedExpression>({ type: "ParenthesizedExpression", expression }, t.start);
          }
          case "[":
            return this.parseArray();
          case "{":
            return this.parseStruct();
        }
        break;
    }
    this.error(`Expected an expression but found ${describe(t)}`);
    return this.invalidExpression();
  }

  private invalidExpression(): AST.InvalidExpression {
    const at = this.tok.start;
    return this.finish<AST.InvalidExpression>({ type: "InvalidExpression" }, at, at);
  }

  private parseFunctionExpression(): AST.FunctionExpression {
    const start = this.advance().start;
    let id: AST.Identifier | null = null;
    if (this.tok.kind === "Identifier") id = this.identifierFrom(this.advance());
    const rest = this.parseFunctionRest();
    return this.finish<AST.FunctionExpression>({ type: "FunctionExpression", id, ...rest }, start);
  }

  private parseNew(): AST.NewExpression {
    const start = this.advance().start;
    const callee = this.parsePostfix(this.parsePrimary(), false);
    let args: Array<AST.Expression | null> = [];
    if (this.is("(")) args = this.parseArguments();
    else this.error("Expected '(' after constructor name");
    return this.finish<AST.NewExpression>({ type: "NewExpression", callee, arguments: args }, start);
  }

  private parseArray(): AST.ArrayExpression {
    const open = this.advance();
    const elements: AST.Expression[] = [];
    while (!this.atEOF && !this.is("]")) {
      elements.push(this.parseExpression());
      if (!this.eat(",")) break;
    }
    if (!this.eat("]")) this.errorAt("Expected ']' to close the array", open.start, open.end);
    return this.finish<AST.ArrayExpression>({ type: "ArrayExpression", elements }, open.start);
  }

  private parseStruct(): AST.StructExpression {
    const open = this.advance();
    const properties: AST.StructProperty[] = [];
    while (!this.atEOF && !this.is("}")) {
      const k = this.tok;
      let key: AST.Identifier | AST.Literal;
      if (k.kind === "Identifier" || k.kind === "Keyword") {
        this.advance();
        key = this.identifierFrom(k);
      } else if (k.kind === "String") {
        this.advance();
        key = this.literalFrom(k);
      } else {
        this.error("Expected a struct key");
        while (!this.atEOF && !this.is(",") && !this.is("}")) this.advance();
        if (!this.eat(",")) break;
        continue;
      }
      let value: AST.Expression | null = null;
      if (this.eat(":")) value = this.parseExpression();
      properties.push(this.finish<AST.StructProperty>({ type: "StructProperty", key, value }, k.start));
      if (!this.eat(",")) break;
    }
    if (!this.eat("}")) this.errorAt("Expected '}' to close the struct", open.start, open.end);
    return this.finish<AST.StructExpression>({ type: "StructExpression", properties }, open.start);
  }

  private templateLiteral(t: LexToken): AST.TemplateLiteral {
    const info = t.template!;
    const quasis = info.chunks.map((c) =>
      this.finish<AST.TemplateElement>({ type: "TemplateElement", value: c.text }, c.range[0], c.range[1]),
    );
    const expressions: AST.Expression[] = [];
    for (const [hs, he] of info.holes) {
      const sub = new Parser(this.text, this.lineMap, hs, he);
      const r = sub.parseStandaloneExpression();
      for (const e of r.errors) this.errors.push(e);
      expressions.push(r.expression ?? this.finish<AST.InvalidExpression>({ type: "InvalidExpression" }, hs, he));
    }
    while (quasis.length < expressions.length + 1) {
      quasis.push(this.finish<AST.TemplateElement>({ type: "TemplateElement", value: "" }, t.end, t.end));
    }
    return this.finish<AST.TemplateLiteral>({ type: "TemplateLiteral", quasis, expressions }, t.start, t.end);
  }

  private startsExpression(t: LexToken): boolean {
    switch (t.kind) {
      case "Identifier":
      case "Number":
      case "String":
      case "Template":
        return true;
      case "Keyword":
        return ["true", "false", "undefined", "function", "new", "not"].includes(t.value);
      case "Punctuator":
        return ["(", "[", "{", "-", "+", "!", "~", "++", "--"].includes(t.value);
      default:
        return false;
    }
  }

  private startsStatementKeyword(t: LexToken): boolean {
    return t.kind === "Keyword" && STATEMENT_KEYWORDS.has(t.value) && t.value !== "function";
  }
}

function describe(t: LexToken): string {
  if (t.kind === "EOF") return "end of file";
  if (t.kind === "Identifier") return `identifier '${t.value}'`;
  if (t.kind === "Number") return `number '${t.value}'`;
  if (t.kind === "String" || t.kind === "Template") return "string";
  return `'${t.value}'`;
}

// ---------------------------------------------------------------------------
// Directive placement
// ---------------------------------------------------------------------------

/** Inserts directive nodes into the innermost statement list containing them. */
function insertDirectives(program: AST.Program, directives: Directive[]): void {
  if (directives.length === 0) return;
  const containers: Array<{ range: AST.Range; list: AST.Statement[] }> = [];
  traverse(program, {
    enter(n) {
      if (n.type === "BlockStatement") containers.push({ range: n.range, list: n.body });
      else if (n.type === "SwitchCase") containers.push({ range: n.range, list: n.consequent });
    },
  });

  for (const d of directives) {
    let best: AST.Statement[] = program.body;
    let bestSize = Infinity;
    for (const c of containers) {
      if (c.range[0] < d.range[0] && d.range[1] <= c.range[1]) {
        const size = c.range[1] - c.range[0];
        if (size < bestSize) {
          bestSize = size;
          best = c.list;
        }
      }
    }
    let i = 0;
    while (i < best.length && best[i]!.range[0] < d.range[0]) i++;
    best.splice(i, 0, d);
  }
}
