// Single responsibility: Exclusive XML Canonicalization 1.0 without comments over one element's
// subtree — the bytes a SAML signature covers. Comments are dropped, which is why a reader taking
// only a NameID's FIRST text node is fooled by `ada@corp.com<!---->.evil.com`: the signature
// covers the concatenation, so `saml-xml.ts` readers concatenate too.

import type { XmlAttribute, XmlElement } from './saml-xml';

export interface C14nOptions {
  /** The enveloped `ds:Signature`: it and its subtree are not part of the node set. */
  readonly exclude?: XmlElement | undefined;
  /** `InclusiveNamespaces PrefixList`; `#default` names the default namespace. */
  readonly inclusivePrefixes?: readonly string[] | undefined;
}

/** `&name;` — one XML entity or character reference, as Exclusive C14N §2.3 writes it. */
const ref = (name: string): string => `&${name};`;

/**
 * C14N's own tables, NOT core's `escapeHtml`: the spec fixes them byte for byte — `>` escaped in
 * text but never in an attribute, `'` never, and CR/TAB/LF as `&#xD;`/`&#x9;`/`&#xA;` — and one
 * byte off is a digest mismatch. `escapeHtml` is right for markup and wrong here.
 */
const TEXT_REFS: ReadonlyMap<string, string> = new Map([
  ['&', ref('amp')],
  ['<', ref('lt')],
  ['>', ref('gt')],
  ['\r', ref('#xD')],
]);
const ATTRIBUTE_REFS: ReadonlyMap<string, string> = new Map([
  ['&', ref('amp')],
  ['<', ref('lt')],
  ['"', ref('quot')],
  ['\t', ref('#x9')],
  ['\n', ref('#xA')],
  ['\r', ref('#xD')],
]);

/** A text node in canonical form. */
export const c14nText = (value: string): string =>
  value.replace(/[&<>\r]/g, (char) => TEXT_REFS.get(char) ?? char);

/** An attribute value in canonical form, for between double quotes. */
export const c14nAttribute = (value: string): string =>
  value.replace(/[&<"\t\n\r]/g, (char) => ATTRIBUTE_REFS.get(char) ?? char);

/** Code-unit order, which for the ASCII names SAML uses is the spec's code-point order. */
const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The prefixes this element visibly utilises: its own, and its prefixed attributes' (`xml:` is
 * never declared). An InclusiveNamespaces prefix is rendered by the inclusive rule instead — when
 * it is in scope at all.
 */
function wanted(element: XmlElement, inclusive: ReadonlySet<string>): Set<string> {
  const prefixes = new Set<string>([element.prefix ?? '']);
  for (const attribute of element.attributes) {
    if (attribute.prefix !== null && attribute.prefix !== 'xml') prefixes.add(attribute.prefix);
  }
  for (const prefix of inclusive) if (element.scope.has(prefix)) prefixes.add(prefix);
  return prefixes;
}

function namespaces(
  element: XmlElement,
  rendered: Map<string, string>,
  inclusive: ReadonlySet<string>,
): string {
  const out: [string, string][] = [];
  for (const prefix of wanted(element, inclusive)) {
    const uri = element.scope.get(prefix) ?? '';
    // An empty default is only worth saying when an output ancestor said a non-empty one.
    const previous = rendered.get(prefix) ?? '';
    if (prefix === '' ? uri === previous : rendered.get(prefix) === uri) continue;
    rendered.set(prefix, uri);
    out.push([prefix, uri]);
  }
  out.sort((a, b) => byKey(a[0], b[0]));
  return out
    .map(
      ([prefix, uri]) => ` ${prefix === '' ? 'xmlns' : `xmlns:${prefix}`}="${c14nAttribute(uri)}"`,
    )
    .join('');
}

const attributeOrder = (a: XmlAttribute, b: XmlAttribute): number =>
  byKey(a.ns, b.ns) || byKey(a.local, b.local);

function render(
  element: XmlElement,
  rendered: ReadonlyMap<string, string>,
  options: C14nOptions,
  inclusive: ReadonlySet<string>,
  out: string[],
): void {
  const scope = new Map(rendered);
  out.push(`<${element.qname}${namespaces(element, scope, inclusive)}`);
  for (const attribute of [...element.attributes].sort(attributeOrder)) {
    out.push(` ${attribute.qname}="${c14nAttribute(attribute.value)}"`);
  }
  out.push('>');
  for (const child of element.children) {
    if (child.kind === 'text') out.push(c14nText(child.value));
    else if (child.kind === 'element' && child !== options.exclude) {
      render(child, scope, options, inclusive, out);
    }
  }
  out.push(`</${element.qname}>`);
}

/** The canonical form of `apex`'s subtree, as the string whose UTF-8 bytes are digested. */
export function exclusiveC14n(apex: XmlElement, options: C14nOptions = {}): string {
  const inclusive = new Set(
    (options.inclusivePrefixes ?? []).map((prefix) => (prefix === '#default' ? '' : prefix)),
  );
  const out: string[] = [];
  render(apex, new Map(), options, inclusive, out);
  return out.join('');
}
