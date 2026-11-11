/**
 * GML JSDoc (`///` comment blocks) parsing and attachment.
 *
 * Recognised tags: @description/@desc, @param/@arg/@argument,
 * @returns/@return, @self/@context, @pure, @deprecated, @ignore/@hide.
 * Others (@function, @func, ...) are ignored.
 */

import type { Comment, Program, Range } from "@gml-lint/parser";
import { parseType, type Type } from "./types.js";

export interface DocParam {
  name: string;
  /** Raw type text without braces, or null. */
  typeText: string | null;
  type: Type | null;
  optional: boolean;
  description: string;
  /** Range of the `@param` line. */
  range: Range;
  /** Range of the type text (inside braces), if any. */
  typeRange: Range | null;
}

export interface DocComment {
  /** Range covering every `///` line of the block. */
  range: Range;
  description: string;
  params: DocParam[];
  returns: { typeText: string | null; type: Type | null; description: string; range: Range; typeRange: Range | null } | null;
  self: { typeText: string; type: Type; range: Range; typeRange: Range | null } | null;
  pure: boolean;
  deprecated: boolean;
  ignore: boolean;
}

/** Groups consecutive `///` line comments into doc blocks. */
export function collectDocComments(program: Program, text: string): DocComment[] {
  const blocks: Comment[][] = [];
  let current: Comment[] = [];
  let lastEnd = -1;
  for (const c of program.comments) {
    const isDoc = c.type === "Line" && c.value.startsWith("/") && !c.value.startsWith("//");
    if (!isDoc) {
      if (current.length) blocks.push(current);
      current = [];
      lastEnd = -1;
      continue;
    }
    if (current.length && !onlyWhitespaceWithOneNewline(text, lastEnd, c.range[0])) {
      blocks.push(current);
      current = [];
    }
    current.push(c);
    lastEnd = c.range[1];
  }
  if (current.length) blocks.push(current);
  return blocks.map(parseDocBlock);
}

function onlyWhitespaceWithOneNewline(text: string, from: number, to: number): boolean {
  const between = text.slice(from, to);
  if (!/^\s*$/.test(between)) return false;
  return (between.match(/\n/g) ?? []).length <= 1;
}

const TAG_RE = /^\s*@(\w+)\s*(.*)$/s;

export function parseDocBlock(comments: Comment[]): DocComment {
  const first = comments[0]!;
  const last = comments[comments.length - 1]!;
  const doc: DocComment = {
    range: [first.range[0], last.range[1]],
    description: "",
    params: [],
    returns: null,
    self: null,
    pure: false,
    deprecated: false,
    ignore: false,
  };
  const descriptionLines: string[] = [];
  for (const c of comments) {
    // value starts with "/" (from "///")
    const body = c.value.slice(1);
    const bodyStart = c.range[0] + 3;
    const m = TAG_RE.exec(body);
    if (!m) {
      const line = body.trim();
      if (line) descriptionLines.push(line);
      continue;
    }
    const tag = m[1]!.toLowerCase();
    const rest = m[2] ?? "";
    const restStart = bodyStart + body.length - rest.length;
    switch (tag) {
      case "description":
      case "desc":
        descriptionLines.push(rest.trim());
        break;
      case "param":
      case "arg":
      case "argument": {
        const p = parseParamTag(rest, restStart, c.range);
        if (p) doc.params.push(p);
        break;
      }
      case "returns":
      case "return": {
        const { typeText, typeRange, after } = readType(rest, restStart);
        doc.returns = {
          typeText,
          type: typeText ? parseType(typeText) : null,
          description: after.trim(),
          range: c.range,
          typeRange,
        };
        break;
      }
      case "self":
      case "context": {
        const { typeText, typeRange, after } = readType(rest, restStart);
        const t = typeText ?? after.trim().split(/\s+/)[0] ?? "";
        if (t) doc.self = { typeText: t, type: parseSelfType(t), range: c.range, typeRange };
        break;
      }
      case "pure":
        doc.pure = true;
        break;
      case "deprecated":
        doc.deprecated = true;
        break;
      case "ignore":
      case "hide":
        doc.ignore = true;
        break;
    }
  }
  doc.description = descriptionLines.join("\n");
  return doc;
}

/** `@self obj_player` names an object; `@self {Struct.Foo}` a type. */
function parseSelfType(text: string): Type {
  if (/^(obj_|o[A-Z])/.test(text) || !/[.\[<|]/.test(text) && !/^(Struct|Id|Asset|Real|String|Any|Array|Bool|Function|Constant|Pointer)\b/.test(text)) {
    return { kind: "instance", object: text };
  }
  return parseType(text);
}

function readType(rest: string, restStart: number): { typeText: string | null; typeRange: Range | null; after: string } {
  const lead = rest.length - rest.trimStart().length;
  const s = rest.trimStart();
  if (!s.startsWith("{")) return { typeText: null, typeRange: null, after: rest };
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) {
        const typeText = s.slice(1, i).trim();
        const start = restStart + lead + 1;
        return { typeText, typeRange: [start, start + (i - 1)], after: s.slice(i + 1) };
      }
    }
  }
  return { typeText: s.slice(1).trim(), typeRange: [restStart + lead + 1, restStart + rest.length], after: "" };
}

function parseParamTag(rest: string, restStart: number, lineRange: Range): DocParam | null {
  const { typeText, typeRange, after } = readType(rest, restStart);
  const s = after.trimStart();
  let name: string;
  let optional = false;
  let consumed: number;
  if (s.startsWith("[")) {
    // `[name]` or `[name=default]`
    const close = s.indexOf("]");
    const inner = close === -1 ? s.slice(1) : s.slice(1, close);
    const eq = inner.indexOf("=");
    name = (eq === -1 ? inner : inner.slice(0, eq)).trim();
    optional = true;
    consumed = close === -1 ? s.length : close + 1;
  } else {
    const m = /^[A-Za-z_]\w*|^\.\.\./.exec(s);
    if (!m) return null;
    name = m[0];
    consumed = m[0].length;
  }
  if (!name) return null;
  return {
    name,
    typeText,
    type: typeText ? parseType(typeText) : null,
    optional,
    description: s.slice(consumed).replace(/^\s*-?\s*/, "").trim(),
    range: lineRange,
    typeRange,
  };
}

/**
 * Finds the doc block that documents a declaration starting at `start`:
 * the nearest block that ends before it with only whitespace in between.
 */
export function docFor(docs: DocComment[], text: string, start: number): DocComment | null {
  let lo = 0;
  let hi = docs.length - 1;
  let found: DocComment | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = docs[mid]!;
    if (d.range[1] <= start) {
      found = d;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (!found) return null;
  return /^\s*$/.test(text.slice(found.range[1], start)) ? found : null;
}
