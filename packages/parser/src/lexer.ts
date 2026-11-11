/**
 * GML lexer.
 *
 * Produces the full token stream up front (the parser needs arbitrary
 * lookahead for things like `function` vs. `function(`), plus comments and
 * diagnostics. Never throws: unknown characters become `Invalid` tokens.
 */

import type { LiteralKind, Range } from "./ast.js";

export type LexKind =
  | "Identifier"
  | "Keyword"
  | "Punctuator"
  | "Number"
  | "String"
  | "Template"
  | "Directive"
  | "Invalid"
  | "EOF";

export interface TemplatePart {
  /** Raw chunk text and its range. */
  text: string;
  range: Range;
}

export interface LexToken {
  kind: LexKind;
  /** Source text of the token (for Directive: the whole directive line(s)). */
  value: string;
  start: number;
  end: number;
  /** A line break occurs between the previous token (or comment) and this one. */
  newlineBefore: boolean;
  /** Literal details for Number/String tokens. */
  literal?: { kind: LiteralKind; value: number | string };
  /** Template details: chunks and the ranges of `{...}` expression holes. */
  template?: { chunks: TemplatePart[]; holes: Range[] };
  /** Directive details. */
  directive?: DirectiveInfo;
}

export interface DirectiveInfo {
  name: "macro" | "region" | "endregion" | "define";
  /** For macros: the identifier, optional config, and body. */
  macroName?: { text: string; range: Range };
  macroConfig?: { text: string; range: Range };
  body?: { text: string; range: Range };
  /** For region/define: trailing text. */
  argument?: string;
}

export interface LexComment {
  type: "Line" | "Block";
  value: string;
  start: number;
  end: number;
}

export interface LexDiagnostic {
  message: string;
  start: number;
  end: number;
}

export interface LexResult {
  tokens: LexToken[];
  comments: LexComment[];
  diagnostics: LexDiagnostic[];
}

const KEYWORDS: ReadonlySet<string> = new Set([
  "var", "globalvar", "static",
  "if", "then", "else",
  "while", "do", "until", "repeat", "for", "with",
  "switch", "case", "default",
  "break", "continue", "exit", "return",
  "function", "constructor", "new", "delete",
  "enum", "try", "catch", "finally", "throw",
  "begin", "end",
  "and", "or", "xor", "not", "div", "mod",
  "true", "false", "undefined",
]);

/** Punctuators, longest first so the first match wins. */
const PUNCTUATORS = [
  "<<=", ">>=", "??=",
  "==", "!=", "<>", "<=", ">=", "<<", ">>", "&&", "||", "^^", "++", "--",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", ":=", "??",
  "{", "}", "(", ")", "[", "]", ";", ",", ".", ":", "?",
  "+", "-", "*", "/", "%", "&", "|", "^", "~", "!", "<", ">", "=", "@", "$", "#",
];

const ACCESSOR_CHARS = new Set(["|", "?", "#", "@", "$"]);

function isIdentStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isIdentPart(c: number): boolean {
  return isIdentStart(c) || (c >= 48 && c <= 57);
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isHexDigit(c: number): boolean {
  return isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

function isNewline(c: number): boolean {
  return c === 10 || c === 13;
}

export function lex(text: string, offset = 0, end = text.length): LexResult {
  return new Lexer(text, offset, end).run();
}

class Lexer {
  private pos: number;
  private readonly end: number;
  private readonly tokens: LexToken[] = [];
  private readonly comments: LexComment[] = [];
  private readonly diagnostics: LexDiagnostic[] = [];
  private newlineBefore = true;
  private readonly text: string;

  constructor(text: string, start: number, end: number) {
    this.text = text;
    this.pos = start;
    this.end = end;
  }

  run(): LexResult {
    while (true) {
      this.skipTrivia();
      if (this.pos >= this.end) break;
      this.next();
    }
    this.push("EOF", this.end, this.end);
    return { tokens: this.tokens, comments: this.comments, diagnostics: this.diagnostics };
  }

  private code(at: number): number {
    return at < this.end ? this.text.charCodeAt(at) : -1;
  }

  private push(kind: LexKind, start: number, end: number, extra?: Partial<LexToken>): void {
    this.tokens.push({
      kind,
      value: this.text.slice(start, end),
      start,
      end,
      newlineBefore: this.newlineBefore,
      ...extra,
    });
    this.newlineBefore = false;
  }

  private error(message: string, start: number, end: number): void {
    this.diagnostics.push({ message, start, end });
  }

  /** Is `at` the first non-blank character on its line? */
  private atLineStart(at: number): boolean {
    for (let i = at - 1; i >= 0; i--) {
      const c = this.text.charCodeAt(i);
      if (isNewline(c)) return true;
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }

  private skipTrivia(): void {
    const text = this.text;
    while (this.pos < this.end) {
      const c = text.charCodeAt(this.pos);
      if (c === 32 || c === 9 || c === 11 || c === 12 || c === 0xfeff || c === 0xa0) {
        this.pos++;
      } else if (isNewline(c)) {
        this.newlineBefore = true;
        this.pos++;
      } else if (c === 47 /* / */ && this.code(this.pos + 1) === 47) {
        const start = this.pos;
        let p = this.pos + 2;
        while (p < this.end && !isNewline(text.charCodeAt(p))) p++;
        this.comments.push({ type: "Line", value: text.slice(start + 2, p), start, end: p });
        this.pos = p;
      } else if (c === 47 && this.code(this.pos + 1) === 42 /* * */) {
        const start = this.pos;
        const close = text.indexOf("*/", this.pos + 2);
        // GameMaker accepts a block comment running to the end of the file.
        const p = close === -1 || close + 2 > this.end ? this.end : close + 2;
        const body = text.slice(start + 2, close === -1 ? p : close);
        if (/[\r\n]/.test(body)) this.newlineBefore = true;
        this.comments.push({ type: "Block", value: body, start, end: p });
        this.pos = p;
      } else {
        break;
      }
    }
  }

  private previousEndsExpression(): boolean {
    const prev = this.tokens[this.tokens.length - 1];
    if (!prev) return false;
    switch (prev.kind) {
      case "Identifier":
      case "Number":
      case "String":
      case "Template":
        return true;
      case "Keyword":
        return prev.value === "true" || prev.value === "false" || prev.value === "undefined";
      case "Punctuator":
        return prev.value === ")" || prev.value === "]";
      default:
        return false;
    }
  }

  private next(): void {
    const text = this.text;
    const start = this.pos;
    const c = text.charCodeAt(start);
    const n = this.code(start + 1);

    // Directives and colour literals
    if (c === 35 /* # */) {
      if (isIdentStart(n) && this.atLineStart(start) && this.tryDirective(start)) return;
      if (this.tryColour(start)) return;
    }

    if (isIdentStart(c)) {
      let p = start + 1;
      while (isIdentPart(this.code(p))) p++;
      const word = text.slice(start, p);
      this.pos = p;
      this.push(KEYWORDS.has(word) ? "Keyword" : "Identifier", start, p);
      return;
    }

    if (c === 36 /* $ */) {
      if (n === 34 /* " */) return this.template(start);
      if (isHexDigit(n) && !this.afterAccessorOpen()) return this.hexNumber(start, start + 1);
    }

    if (c === 48 /* 0 */ && (n === 120 || n === 88) /* x */ && isHexDigit(this.code(start + 2))) {
      return this.hexNumber(start, start + 2);
    }
    if (c === 48 && (n === 98 || n === 66) /* b */ && (this.code(start + 2) === 48 || this.code(start + 2) === 49)) {
      return this.binaryNumber(start);
    }
    if (isDigit(c) || (c === 46 /* . */ && isDigit(n))) return this.decimal(start);

    if (c === 64 /* @ */ && (n === 34 || n === 39) && !this.afterAccessorOpen()) return this.verbatim(start, n);
    if (c === 34 /* " */) return this.string(start);

    // Accessor openers: `[|`, `[?`, `[#`, `[@`, `[$` directly after an expression
    if (c === 91 /* [ */ && n !== -1 && ACCESSOR_CHARS.has(String.fromCharCode(n)) && this.previousEndsExpression()) {
      this.pos = start + 2;
      this.push("Punctuator", start, start + 2);
      return;
    }

    for (const p of PUNCTUATORS) {
      if (text.startsWith(p, start) && start + p.length <= this.end) {
        this.pos = start + p.length;
        this.push("Punctuator", start, this.pos);
        return;
      }
    }

    // Unknown character (including stray `\`, `'`, backticks, unicode)
    const cp = text.codePointAt(start) ?? 0;
    const len = cp > 0xffff ? 2 : 1;
    this.pos = start + len;
    this.error(`Unexpected character '${text.slice(start, start + len)}'`, start, this.pos);
    this.push("Invalid", start, this.pos);
  }

  /** The previous token is a `[` right before the current position that would open an accessor. */
  private afterAccessorOpen(): boolean {
    const prev = this.tokens[this.tokens.length - 1];
    return !!prev && prev.kind === "Punctuator" && prev.value === "[" && prev.end === this.pos && this.beforeBracketEndsExpression();
  }

  private beforeBracketEndsExpression(): boolean {
    const prev = this.tokens[this.tokens.length - 2];
    if (!prev) return false;
    return (
      prev.kind === "Identifier" ||
      prev.kind === "String" ||
      prev.kind === "Template" ||
      (prev.kind === "Punctuator" && (prev.value === ")" || prev.value === "]"))
    );
  }

  private tryColour(start: number): boolean {
    for (let i = 1; i <= 6; i++) if (!isHexDigit(this.code(start + i))) return false;
    if (isIdentPart(this.code(start + 7))) return false;
    // Not a colour directly after a `[#` grid accessor.
    const prev = this.tokens[this.tokens.length - 1];
    if (prev && prev.kind === "Punctuator" && prev.value === "[#") return false;
    const value = parseInt(this.text.slice(start + 1, start + 7), 16);
    // #RRGGBB is stored as BGR internally
    const r = (value >> 16) & 0xff;
    const g = (value >> 8) & 0xff;
    const b = value & 0xff;
    this.pos = start + 7;
    this.push("Number", start, this.pos, { literal: { kind: "colour", value: (b << 16) | (g << 8) | r } });
    return true;
  }

  private tryDirective(start: number): boolean {
    const text = this.text;
    let p = start + 1;
    while (isIdentPart(this.code(p))) p++;
    const name = text.slice(start + 1, p);
    if (name !== "macro" && name !== "region" && name !== "endregion" && name !== "define") return false;

    if (name !== "macro") {
      let e = p;
      while (e < this.end && !isNewline(text.charCodeAt(e))) e++;
      const argument = text.slice(p, e).trim();
      this.pos = e;
      this.push("Directive", start, e, { directive: { name, argument } });
      return true;
    }

    // #macro [Config:]NAME body, with `\` continuations
    let q = p;
    while (this.code(q) === 32 || this.code(q) === 9) q++;
    const nameStart = q;
    while (isIdentPart(this.code(q))) q++;
    let macroName = { text: text.slice(nameStart, q), range: [nameStart, q] as Range };
    let macroConfig: DirectiveInfo["macroConfig"];
    if (this.code(q) === 58 /* : */ && isIdentStart(this.code(q + 1))) {
      macroConfig = macroName;
      const idStart = ++q;
      while (isIdentPart(this.code(q))) q++;
      macroName = { text: text.slice(idStart, q), range: [idStart, q] };
    }
    if (macroName.text === "") this.error("Expected a macro name", start, q);

    // Body: rest of line(s)
    let bodyStart = q;
    while (this.code(bodyStart) === 32 || this.code(bodyStart) === 9) bodyStart++;
    let e = bodyStart;
    let body = "";
    let segStart = bodyStart;
    while (true) {
      while (e < this.end && !isNewline(text.charCodeAt(e))) e++;
      const line = text.slice(segStart, e);
      // A line continues when it ends with `\`, ignoring a trailing `//` comment.
      const stripped = stripTrailingLineComment(line).replace(/\s+$/, "");
      if (stripped.endsWith("\\") && e < this.end) {
        body += stripped.slice(0, -1) + "\n";
        if (text.charCodeAt(e) === 13 && text.charCodeAt(e + 1) === 10) e += 2;
        else e += 1;
        segStart = e;
        continue;
      }
      body += line;
      break;
    }
    this.pos = e;
    this.push("Directive", start, e, {
      directive: {
        name: "macro",
        macroName,
        ...(macroConfig ? { macroConfig } : {}),
        body: { text: body.replace(/\s+$/, ""), range: [bodyStart, e] },
      },
    });
    return true;
  }

  private hexNumber(start: number, digitsStart: number): void {
    let p = digitsStart;
    while (isHexDigit(this.code(p)) || this.code(p) === 95) p++;
    const digits = this.text.slice(digitsStart, p).replace(/_/g, "");
    this.pos = p;
    this.push("Number", start, p, { literal: { kind: "hex", value: parseInt(digits, 16) } });
  }

  private binaryNumber(start: number): void {
    let p = start + 2;
    while (this.code(p) === 48 || this.code(p) === 49 || this.code(p) === 95) p++;
    const digits = this.text.slice(start + 2, p).replace(/_/g, "");
    this.pos = p;
    this.push("Number", start, p, { literal: { kind: "binary", value: parseInt(digits, 2) } });
  }

  private decimal(start: number): void {
    let p = start;
    while (isDigit(this.code(p)) || this.code(p) === 95) p++;
    if (this.code(p) === 46 /* . */ && !isIdentStart(this.code(p + 1)) && this.code(p + 1) !== 46) {
      p++;
      while (isDigit(this.code(p)) || this.code(p) === 95) p++;
    }
    const raw = this.text.slice(start, p);
    this.pos = p;
    this.push("Number", start, p, { literal: { kind: "real", value: Number(raw.replace(/_/g, "")) } });
  }

  private string(start: number): void {
    const text = this.text;
    let p = start + 1;
    let value = "";
    let terminated = false;
    while (p < this.end) {
      const c = text.charCodeAt(p);
      if (c === 34) {
        p++;
        terminated = true;
        break;
      }
      if (isNewline(c)) break;
      if (c === 92 /* \ */) {
        const [decoded, next] = decodeEscape(text, p, this.end);
        value += decoded;
        p = next;
        continue;
      }
      value += text[p];
      p++;
    }
    if (!terminated) this.error("Unterminated string literal", start, p);
    this.pos = p;
    this.push("String", start, p, { literal: { kind: "string", value } });
  }

  private verbatim(start: number, quote: number): void {
    const close = this.text.indexOf(String.fromCharCode(quote), start + 2);
    const terminated = close !== -1 && close < this.end;
    const p = terminated ? close + 1 : this.end;
    if (!terminated) this.error("Unterminated verbatim string literal", start, p);
    const value = this.text.slice(start + 2, terminated ? close : p);
    this.pos = p;
    this.push("String", start, p, { literal: { kind: "verbatim", value } });
  }

  /** `$"text {expr} text"` — scans the whole literal, recording holes. */
  private template(start: number): void {
    const text = this.text;
    let p = start + 2;
    const chunks: TemplatePart[] = [];
    const holes: Range[] = [];
    let chunkStart = p;
    let terminated = false;
    while (p < this.end) {
      const c = text.charCodeAt(p);
      if (c === 34) {
        chunks.push({ text: text.slice(chunkStart, p), range: [chunkStart, p] });
        p++;
        terminated = true;
        break;
      }
      if (isNewline(c)) break;
      if (c === 92) {
        p += 2;
        continue;
      }
      if (c === 123 /* { */) {
        chunks.push({ text: text.slice(chunkStart, p), range: [chunkStart, p] });
        const holeStart = p + 1;
        const holeEnd = this.scanHole(holeStart);
        holes.push([holeStart, holeEnd]);
        p = holeEnd < this.end ? holeEnd + 1 : holeEnd;
        chunkStart = p;
        continue;
      }
      p++;
    }
    if (!terminated) {
      this.error("Unterminated template string", start, p);
      if (chunks.length === holes.length) chunks.push({ text: text.slice(chunkStart, p), range: [chunkStart, p] });
    }
    this.pos = p;
    this.push("Template", start, p, { template: { chunks, holes } });
  }

  /** Finds the `}` closing a template hole, skipping nested braces and strings. */
  private scanHole(from: number): number {
    const text = this.text;
    let depth = 0;
    let p = from;
    while (p < this.end) {
      const c = text.charCodeAt(p);
      if (c === 34) {
        p++;
        while (p < this.end && text.charCodeAt(p) !== 34 && !isNewline(text.charCodeAt(p))) p += text.charCodeAt(p) === 92 ? 2 : 1;
        p++;
        continue;
      }
      if (c === 36 && this.code(p + 1) === 34) {
        // nested template
        p += 2;
        let nested = 0;
        while (p < this.end) {
          const d = text.charCodeAt(p);
          if (d === 92) { p += 2; continue; }
          if (d === 123) nested++;
          else if (d === 125) nested--;
          else if (d === 34 && nested <= 0) break;
          p++;
        }
        p++;
        continue;
      }
      if (c === 123) depth++;
      else if (c === 125) {
        if (depth === 0) return p;
        depth--;
      } else if (isNewline(c)) {
        return p;
      }
      p++;
    }
    return p;
  }
}

function stripTrailingLineComment(line: string): string {
  // Find `//` outside of a string literal
  let inString: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === "\\" && inString === '"') i++;
      else if (ch === inString) inString = null;
    } else if (ch === '"' || ch === "'") {
      inString = ch;
    } else if (ch === "/" && line[i + 1] === "/") {
      return line.slice(0, i);
    }
  }
  return line;
}

function decodeEscape(text: string, at: number, end: number): [string, number] {
  const e = text[at + 1];
  switch (e) {
    case "n": return ["\n", at + 2];
    case "r": return ["\r", at + 2];
    case "t": return ["\t", at + 2];
    case "b": return ["\b", at + 2];
    case "f": return ["\f", at + 2];
    case "v": return ["\v", at + 2];
    case "a": return ["\x07", at + 2];
    case "\\": return ["\\", at + 2];
    case '"': return ['"', at + 2];
    case "'": return ["'", at + 2];
    case "x": {
      const hex = text.slice(at + 2, Math.min(at + 4, end));
      if (/^[0-9a-fA-F]{2}$/.test(hex)) return [String.fromCharCode(parseInt(hex, 16)), at + 4];
      return ["x", at + 2];
    }
    case "u": {
      const m = /^[0-9a-fA-F]{1,6}/.exec(text.slice(at + 2, Math.min(at + 8, end)));
      if (m) return [String.fromCodePoint(Math.min(parseInt(m[0], 16), 0x10ffff)), at + 2 + m[0].length];
      return ["u", at + 2];
    }
    case undefined: return ["\\", at + 1];
    default: return [e, at + 2];
  }
}
