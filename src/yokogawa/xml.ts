/**
 * A small XML reader.
 *
 * The browser has `DOMParser`, so this exists for two other reasons. A CQ3000
 * OME-XML runs to fourteen megabytes and a hundred thousand elements, and a
 * full DOM of that costs several times the document in memory for an API that
 * is then used to read attributes and nothing else. And a parser written here
 * runs in Node, which is what lets the whole read path be tested against real
 * acquisitions rather than mocked.
 *
 * It handles the subset these documents use — elements, attributes, the five
 * predefined entities and numeric references, comments, CDATA and the XML
 * declaration — and rejects anything it does not understand rather than
 * guessing. Namespace prefixes are dropped: the same information arrives under
 * `bts:` in one vendor file and `icm:` in another, and never ambiguously.
 */

export interface XmlNode {
  /** Local name, with any namespace prefix removed. */
  name: string;
  /** Attributes by local name. `xmlns` declarations are not included. */
  attributes: Record<string, string>;
  children: XmlNode[];
  /** Character data, when the element has any that is not whitespace. */
  text?: string;
}

const ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/** Expand the entity references these documents can contain. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body] ?? match;
  });
}

/** Strip a namespace prefix: `bts:ColumnPitch` becomes `ColumnPitch`. */
function localName(qualified: string): string {
  const colon = qualified.indexOf(':');
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

const NAME = /[^\s/>=]+/y;
const ATTRIBUTE_VALUE = /\s*=\s*("([^"]*)"|'([^']*)')/y;

export class XmlError extends Error {}

/**
 * Parse a document and return its root element.
 *
 * The parser is a single forward scan with an explicit stack: no lookahead, no
 * backtracking, one pass over the source.
 */
export function parseXml(source: string): XmlNode {
  let at = 0;
  let root: XmlNode | null = null;
  const stack: XmlNode[] = [];
  let text = '';

  const flushText = (): void => {
    const node = stack[stack.length - 1];
    if (node && text.trim() !== '') {
      node.text = (node.text ?? '') + decodeEntities(text);
    }
    text = '';
  };

  const skipTo = (marker: string, what: string): void => {
    const end = source.indexOf(marker, at);
    if (end === -1) throw new XmlError(`Unterminated ${what}.`);
    at = end + marker.length;
  };

  const readName = (): string => {
    NAME.lastIndex = at;
    const match = NAME.exec(source);
    if (!match) throw new XmlError(`Expected a name at offset ${at}.`);
    at = NAME.lastIndex;
    return match[0];
  };

  while (at < source.length) {
    const open = source.indexOf('<', at);
    if (open === -1) {
      text += source.slice(at);
      break;
    }
    text += source.slice(at, open);
    at = open + 1;

    if (source.startsWith('!--', at)) {
      skipTo('-->', 'comment');
      continue;
    }
    if (source.startsWith('![CDATA[', at)) {
      const end = source.indexOf(']]>', at);
      if (end === -1) throw new XmlError('Unterminated CDATA section.');
      text += source.slice(at + 8, end);
      at = end + 3;
      continue;
    }
    if (source.startsWith('?', at)) {
      skipTo('?>', 'processing instruction');
      continue;
    }
    if (source.startsWith('!', at)) {
      // A doctype; these documents never carry an internal subset.
      skipTo('>', 'declaration');
      continue;
    }

    if (source.startsWith('/', at)) {
      flushText();
      at += 1;
      const name = localName(readName());
      const closed = stack.pop();
      if (!closed) throw new XmlError(`Unexpected closing tag </${name}>.`);
      if (closed.name !== name) {
        throw new XmlError(`Closing tag </${name}> does not match <${closed.name}>.`);
      }
      skipTo('>', 'closing tag');
      continue;
    }

    flushText();
    const node: XmlNode = { name: localName(readName()), attributes: {}, children: [] };

    for (;;) {
      while (at < source.length && /\s/.test(source[at])) at += 1;
      if (at >= source.length) throw new XmlError('Unterminated start tag.');

      if (source[at] === '>') {
        at += 1;
        stack.push(node);
        break;
      }
      if (source.startsWith('/>', at)) {
        at += 2;
        stack.push(node);
        // Close it immediately, so the attach logic below is shared.
        stack.pop();
        const parent = stack[stack.length - 1];
        if (parent) parent.children.push(node);
        else if (!root) root = node;
        break;
      }

      const attributeName = readName();
      ATTRIBUTE_VALUE.lastIndex = at;
      const value = ATTRIBUTE_VALUE.exec(source);
      if (!value) throw new XmlError(`Attribute ${attributeName} has no value.`);
      at = ATTRIBUTE_VALUE.lastIndex;
      if (attributeName !== 'xmlns' && !attributeName.startsWith('xmlns:')) {
        node.attributes[localName(attributeName)] = decodeEntities(value[2] ?? value[3] ?? '');
      }
    }

    // Attach non-empty elements when they are pushed, so parents keep document
    // order regardless of how deeply their children nest.
    if (stack[stack.length - 1] === node) {
      const parent = stack[stack.length - 2];
      if (parent) parent.children.push(node);
      else if (!root) root = node;
    }
  }

  if (stack.length > 0) throw new XmlError(`Unclosed element <${stack[stack.length - 1].name}>.`);
  if (!root) throw new XmlError('The document has no root element.');
  return root;
}

/** Direct children with this local name. */
export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

/** First direct child with this local name. */
export function childNamed(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((child) => child.name === name);
}

/** Every element in the tree with this local name, including the root. */
export function descendantsNamed(node: XmlNode, name: string): XmlNode[] {
  const found: XmlNode[] = [];
  const walk = (current: XmlNode): void => {
    if (current.name === name) found.push(current);
    for (const child of current.children) walk(child);
  };
  walk(node);
  return found;
}
