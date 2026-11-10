// Single responsibility: a strict, namespace-aware XML reader for the SAML subset — a tree that
// keeps exactly what exclusive c14n and XML-DSig need (prefixes, in-scope namespaces, comments as
// nodes) and REFUSES what SAML never needs and attackers always do: a DOCTYPE (entity expansion,
// XXE), a processing instruction, an unknown entity, an undeclared prefix, a duplicate attribute.

/** The namespace `xml:` is bound to by definition (Namespaces in XML 1.0 §3). */
export const XML_NS = 'http://www.w3.org/XML/1998/namespace';

export interface XmlAttribute {
  readonly qname: string;
  readonly prefix: string | null;
  readonly local: string;
  /** `''` for an unprefixed attribute: it is in no namespace. */
  readonly ns: string;
  readonly value: string;
}

export interface XmlText {
  readonly kind: 'text';
  readonly value: string;
}

export interface XmlComment {
  readonly kind: 'comment';
  readonly value: string;
}

export interface XmlElement {
  readonly kind: 'element';
  readonly qname: string;
  readonly prefix: string | null;
  readonly local: string;
  readonly ns: string;
  readonly attributes: readonly XmlAttribute[];
  /** Every prefix (`''` for the default) in scope here, ancestors' declarations included. */
  readonly scope: NamespaceScope;
  readonly children: readonly XmlNode[];
  readonly parent: XmlElement | null;
}

export type XmlNode = XmlElement | XmlText | XmlComment;

/** A prefix lookup through the element's own declarations, then its ancestors'. */
export interface NamespaceScope {
  get(prefix: string): string | undefined;
  has(prefix: string): boolean;
}

/**
 * Each element keeps only ITS declarations and asks its parent for the rest. A copied map per
 * declaring element was K declarations × N elements of memory — 5 GB from one 334 KB POST.
 * Depth is capped at `MAX_DEPTH`, so a lookup walks at most that many links.
 */
class ScopeChain implements NamespaceScope {
  constructor(
    private readonly own: ReadonlyMap<string, string>,
    private readonly parent: NamespaceScope | null,
  ) {}
  get(prefix: string): string | undefined {
    return this.own.get(prefix) ?? this.parent?.get(prefix);
  }
  has(prefix: string): boolean {
    return this.get(prefix) !== undefined;
  }
}

const NO_SCOPE: NamespaceScope = { get: () => undefined, has: () => false };

export type XmlParse =
  | { readonly ok: true; readonly root: XmlElement }
  | { readonly ok: false; readonly reason: string };

/** A SAML response is a few KiB; an IdP metadata file with many certificates, tens. */
export const MAX_XML_LENGTH = 512 * 1024;
const MAX_DEPTH = 64;
/** Namespace declarations per document. SAML uses a handful; every one is lookup work per element. */
export const MAX_NAMESPACE_DECLARATIONS = 64;

const NAME = /^[A-Za-z_][A-Za-z0-9._-]*(?::[A-Za-z_][A-Za-z0-9._-]*)?/;
/** A `Map`, so an entity name from the document never reaches `Object.prototype` (`proto-index`). */
const PREDEFINED: ReadonlyMap<string, string> = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);
/** XML 1.0 `Char` minus the line breaks and tab, which are handled before this is asked. */
const isXmlChar = (code: number): boolean =>
  code === 0x9 ||
  code === 0xa ||
  code === 0xd ||
  (code >= 0x20 && code <= 0xd7ff) ||
  (code >= 0xe000 && code <= 0xfffd) ||
  (code >= 0x10000 && code <= 0x10ffff);

class Refusal {
  constructor(readonly reason: string) {}
}
const refuse = (reason: string): never => {
  throw new Refusal(reason);
};

/** Entity and character references, decoded; anything else after `&` is refused. */
function decode(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&([^;&]*);|&/g, (whole, body: string | undefined) => {
    if (body === undefined) return refuse('a bare & is not a reference');
    const named = PREDEFINED.get(body);
    if (named !== undefined) return named;
    const match = /^#(?:x([0-9A-Fa-f]{1,6})|([0-9]{1,7}))$/.exec(body);
    if (match === null)
      return refuse(`${whole.length > 12 ? 'an' : whole} entity is not one of the five predefined`);
    const code = match[1] === undefined ? Number(match[2]) : Number.parseInt(match[1], 16);
    if (!isXmlChar(code)) return refuse('a character reference names no XML character');
    return String.fromCodePoint(code);
  });
}

function assertChars(text: string): void {
  for (const char of text) {
    if (!isXmlChar(char.codePointAt(0) ?? 0)) refuse('the document carries a non-XML character');
  }
}

interface RawAttribute {
  readonly qname: string;
  readonly value: string;
}

class Reader {
  at = 0;
  /** Namespace declarations read so far, across the whole document. */
  declarations = 0;
  constructor(readonly text: string) {}

  startsWith(marker: string): boolean {
    return this.text.startsWith(marker, this.at);
  }

  skipSpace(): void {
    while (/[ \t\n]/.test(this.text[this.at] ?? '')) this.at += 1;
  }

  name(): string {
    const match = NAME.exec(this.text.slice(this.at, this.at + 256));
    if (match === null) return refuse('a name was expected');
    this.at += match[0].length;
    return match[0];
  }

  until(marker: string, what: string): string {
    const end = this.text.indexOf(marker, this.at);
    if (end < 0) return refuse(`an unterminated ${what}`);
    const body = this.text.slice(this.at, end);
    this.at = end + marker.length;
    return body;
  }
}

function split(qname: string): { prefix: string | null; local: string } {
  const colon = qname.indexOf(':');
  return colon < 0
    ? { prefix: null, local: qname }
    : { prefix: qname.slice(0, colon), local: qname.slice(colon + 1) };
}

function readAttributes(reader: Reader): RawAttribute[] {
  const out: RawAttribute[] = [];
  const names = new Set<string>();
  for (;;) {
    const before = reader.at;
    reader.skipSpace();
    if (reader.startsWith('>') || reader.startsWith('/>')) return out;
    if (reader.at === before) refuse('attributes must be separated by white space');
    const qname = reader.name();
    // By qname, before any namespace resolves: `xmlns:p` twice would otherwise be last-one-wins.
    if (names.has(qname)) refuse('an element carries one attribute twice');
    names.add(qname);
    reader.skipSpace();
    if (!reader.startsWith('=')) refuse('an attribute has no value');
    reader.at += 1;
    reader.skipSpace();
    const quote = reader.text[reader.at];
    if (quote !== '"' && quote !== "'") return refuse('an attribute value is not quoted');
    reader.at += 1;
    const raw = reader.until(quote, 'attribute value');
    if (raw.includes('<')) refuse('an attribute value carries <');
    // Attribute-value normalisation (XML 1.0 §3.3.3): a literal tab or line break is a space;
    // one written as a character reference is not, which is why this runs before `decode`.
    out.push({ qname, value: decode(raw.replace(/[\t\n]/g, ' ')) });
  }
}

function scopeFor(reader: Reader, raw: readonly RawAttribute[], inherited: NamespaceScope) {
  let own: Map<string, string> | null = null;
  for (const { qname, value } of raw) {
    if (qname !== 'xmlns' && !qname.startsWith('xmlns:')) continue;
    const prefix = qname === 'xmlns' ? '' : qname.slice(6);
    if (prefix === 'xml' || prefix === 'xmlns') refuse('the xml and xmlns prefixes are reserved');
    if (prefix !== '' && value === '') refuse('a prefix may not be undeclared');
    reader.declarations += 1;
    if (reader.declarations > MAX_NAMESPACE_DECLARATIONS) {
      refuse(`the document carries more than ${MAX_NAMESPACE_DECLARATIONS} namespace declarations`);
    }
    own ??= new Map();
    own.set(prefix, value);
  }
  // An element that declares nothing shares its parent's scope object: no allocation at all.
  return own === null ? inherited : new ScopeChain(own, inherited);
}

function resolve(prefix: string | null, scope: NamespaceScope, attr: boolean): string {
  if (prefix === null) return attr ? '' : (scope.get('') ?? '');
  if (prefix === 'xml') return XML_NS;
  const ns = scope.get(prefix);
  return ns === undefined ? refuse('a prefix is used without a declaration') : ns;
}

function element(reader: Reader, parent: XmlElement | null, depth: number): XmlElement {
  if (depth > MAX_DEPTH) refuse('the document nests deeper than any SAML message');
  reader.at += 1; // '<'
  const qname = reader.name();
  const raw = readAttributes(reader);
  const scope = scopeFor(reader, raw, parent?.scope ?? NO_SCOPE);
  const attributes: XmlAttribute[] = [];
  const seen = new Set<string>();
  for (const { qname: name, value } of raw) {
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
    const { prefix, local } = split(name);
    const ns = resolve(prefix, scope, true);
    if (seen.has(`${ns} ${local}`)) refuse('an element carries one attribute twice');
    seen.add(`${ns} ${local}`);
    attributes.push({ qname: name, prefix, local, ns, value });
  }
  const { prefix, local } = split(qname);
  const children: XmlNode[] = [];
  const node: XmlElement = {
    kind: 'element',
    qname,
    prefix,
    local,
    ns: resolve(prefix, scope, false),
    attributes,
    scope,
    children,
    parent,
  };
  if (reader.startsWith('/>')) {
    reader.at += 2;
    return node;
  }
  reader.at += 1; // '>'
  content(reader, node, children, depth);
  return node;
}

function pushText(children: XmlNode[], value: string): void {
  if (value === '') return;
  const last = children.at(-1);
  if (last?.kind === 'text')
    children[children.length - 1] = { kind: 'text', value: last.value + value };
  else children.push({ kind: 'text', value });
}

function content(reader: Reader, node: XmlElement, children: XmlNode[], depth: number): void {
  for (;;) {
    const lt = reader.text.indexOf('<', reader.at);
    if (lt < 0) refuse('an element is never closed');
    const text = reader.text.slice(reader.at, lt);
    if (text.includes(']]>')) refuse('text carries ]]>');
    pushText(children, decode(text));
    reader.at = lt;
    if (reader.startsWith('</')) {
      reader.at += 2;
      if (reader.name() !== node.qname) refuse('an end tag does not match its start tag');
      reader.skipSpace();
      if (!reader.startsWith('>')) refuse('an end tag is not closed');
      reader.at += 1;
      return;
    }
    if (reader.startsWith('<!--')) {
      reader.at += 4;
      const body = reader.until('-->', 'comment');
      if (body.includes('--') || body.endsWith('-')) refuse('a comment carries --');
      children.push({ kind: 'comment', value: body });
    } else if (reader.startsWith('<![CDATA[')) {
      reader.at += 9;
      pushText(children, reader.until(']]>', 'CDATA section'));
    } else if (reader.startsWith('<!') || reader.startsWith('<?')) {
      refuse('a DOCTYPE, entity declaration or processing instruction is refused');
    } else {
      children.push(element(reader, node, depth + 1));
    }
  }
}

/** Comments and white space are all that may stand outside the root. */
function misc(reader: Reader): void {
  for (;;) {
    reader.skipSpace();
    if (!reader.startsWith('<!--')) return;
    reader.at += 4;
    reader.until('-->', 'comment');
  }
}

export function parseXml(input: string): XmlParse {
  if (input.length > MAX_XML_LENGTH) return { ok: false, reason: 'the document is too large' };
  try {
    // Line-end normalisation (XML 1.0 §2.11) before anything else reads a character.
    const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    assertChars(text);
    const reader = new Reader(text);
    if (/^<\?xml[ \t\n]/.test(text)) reader.until('?>', 'XML declaration');
    misc(reader);
    if (!reader.startsWith('<') || reader.startsWith('<!') || reader.startsWith('<?')) {
      refuse('the document has no root element, or a DOCTYPE or processing instruction before it');
    }
    const root = element(reader, null, 0);
    misc(reader);
    if (reader.at !== text.length) refuse('content follows the root element');
    return { ok: true, root };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.reason };
    throw error;
  }
}
