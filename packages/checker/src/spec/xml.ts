/**
 * Minimal, fast, non-validating XML reader sufficient for GmlSpec.xml.
 *
 * Supports elements, attributes (single/double quoted), self-closing tags,
 * text, CDATA, comments, processing instructions and DOCTYPE (skipped), and
 * the predefined + numeric character entities. Namespaces are not
 * interpreted (prefixed names are kept verbatim).
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Concatenated, entity-decoded text content of direct text/CDATA children. */
  text: string;
}

const ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.-]*);/g;

function decodeEntities(s: string): string {
  if (s.indexOf("&") === -1) return s;
  return s.replace(ENTITY_RE, (whole, body: string) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const code =
        body.charCodeAt(1) === 120 /* x */ ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) return String.fromCodePoint(code);
      return whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

export class XmlParseError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = "XmlParseError";
    this.offset = offset;
  }
}

const NAME_RE = /[^\s/>=]+/y;
const ATTR_RE = /\s*([^\s/>=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
const WS_RE = /\s*/y;

/** Parse an XML document and return its root element. */
export function parseXml(src: string): XmlElement {
  const len = src.length;
  let pos = 0;
  if (src.charCodeAt(0) === 0xfeff) pos = 1;

  const stack: XmlElement[] = [];
  const textParts: string[][] = [];
  let root: XmlElement | undefined;

  const appendText = (t: string): void => {
    const parts = textParts[textParts.length - 1];
    if (parts) parts.push(t);
  };

  while (pos < len) {
    const lt = src.indexOf("<", pos);
    if (lt === -1) {
      appendText(decodeEntities(src.slice(pos)));
      break;
    }
    if (lt > pos) appendText(decodeEntities(src.slice(pos, lt)));
    pos = lt;
    const c1 = src.charCodeAt(pos + 1);

    if (c1 === 33 /* ! */) {
      if (src.startsWith("<!--", pos)) {
        const end = src.indexOf("-->", pos + 4);
        if (end === -1) throw new XmlParseError("Unterminated comment", pos);
        pos = end + 3;
      } else if (src.startsWith("<![CDATA[", pos)) {
        const end = src.indexOf("]]>", pos + 9);
        if (end === -1) throw new XmlParseError("Unterminated CDATA section", pos);
        appendText(src.slice(pos + 9, end));
        pos = end + 3;
      } else {
        // DOCTYPE or other declaration; skip, honouring an internal subset.
        let depth = 0;
        let i = pos + 2;
        for (; i < len; i++) {
          const ch = src.charCodeAt(i);
          if (ch === 91 /* [ */) depth++;
          else if (ch === 93 /* ] */) depth--;
          else if (ch === 62 /* > */ && depth <= 0) break;
        }
        pos = i + 1;
      }
      continue;
    }

    if (c1 === 63 /* ? */) {
      const end = src.indexOf("?>", pos + 2);
      if (end === -1) throw new XmlParseError("Unterminated processing instruction", pos);
      pos = end + 2;
      continue;
    }

    if (c1 === 47 /* / */) {
      const gt = src.indexOf(">", pos + 2);
      if (gt === -1) throw new XmlParseError("Unterminated end tag", pos);
      const name = src.slice(pos + 2, gt).trim();
      const el = stack.pop();
      const parts = textParts.pop();
      if (!el || !parts) throw new XmlParseError(`Unexpected end tag </${name}>`, pos);
      if (el.name !== name) throw new XmlParseError(`Mismatched end tag </${name}> for <${el.name}>`, pos);
      el.text = parts.length === 1 ? (parts[0] as string) : parts.join("");
      pos = gt + 1;
      continue;
    }

    // Start tag.
    NAME_RE.lastIndex = pos + 1;
    const nm = NAME_RE.exec(src);
    if (!nm) throw new XmlParseError("Invalid tag name", pos);
    const el: XmlElement = { name: nm[0], attrs: {}, children: [], text: "" };
    pos = NAME_RE.lastIndex;
    for (;;) {
      ATTR_RE.lastIndex = pos;
      const am = ATTR_RE.exec(src);
      if (!am) break;
      el.attrs[am[1] as string] = decodeEntities(am[2] ?? am[3] ?? "");
      pos = ATTR_RE.lastIndex;
    }
    WS_RE.lastIndex = pos;
    WS_RE.exec(src);
    pos = WS_RE.lastIndex;

    let selfClosing = false;
    if (src.charCodeAt(pos) === 47 /* / */ && src.charCodeAt(pos + 1) === 62) {
      selfClosing = true;
      pos += 2;
    } else if (src.charCodeAt(pos) === 62 /* > */) {
      pos += 1;
    } else {
      throw new XmlParseError(`Malformed start tag <${el.name}>`, pos);
    }

    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else if (!root) root = el;
    else throw new XmlParseError("Multiple root elements", lt);

    if (!selfClosing) {
      stack.push(el);
      textParts.push([]);
    }
  }

  if (stack.length > 0) {
    throw new XmlParseError(`Unclosed element <${(stack[stack.length - 1] as XmlElement).name}>`, len);
  }
  if (!root) throw new XmlParseError("No root element", 0);
  return root;
}
