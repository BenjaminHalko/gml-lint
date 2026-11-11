/**
 * Tolerant reader for GameMaker's .yy / .yyp JSON dialect: strips a BOM and
 * trailing commas (`{"a":1,}`, `[1,2,]`) outside strings, then JSON.parse.
 */

const QUOTE = 0x22; // "
const BACKSLASH = 0x5c; // \
const COMMA = 0x2c; // ,
const RBRACE = 0x7d; // }
const RBRACKET = 0x5d; // ]
const SPACE = 0x20;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;

function isWs(c: number): boolean {
  return c === SPACE || c === LF || c === CR || c === TAB;
}

/** Removes trailing commas outside strings. Returns the input unchanged if there are none. */
function stripTrailingCommas(text: string): string {
  const len = text.length;
  let out: string[] | null = null;
  let chunkStart = 0;
  let i = 0;
  while (i < len) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) {
      // Skip string literal.
      i++;
      while (i < len) {
        const s = text.charCodeAt(i);
        if (s === BACKSLASH) {
          i += 2;
          continue;
        }
        i++;
        if (s === QUOTE) break;
      }
      continue;
    }
    if (c === COMMA) {
      let j = i + 1;
      while (j < len && isWs(text.charCodeAt(j))) j++;
      const n = j < len ? text.charCodeAt(j) : -1;
      if (n === RBRACE || n === RBRACKET) {
        (out ??= []).push(text.slice(chunkStart, i));
        chunkStart = i + 1;
      }
    }
    i++;
  }
  if (out === null) return text;
  out.push(text.slice(chunkStart));
  return out.join("");
}

/** Parses GameMaker .yy/.yyp text. Throws a SyntaxError if it is not valid even after cleanup. */
export function readYY(text: string): unknown {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(stripTrailingCommas(body));
}
