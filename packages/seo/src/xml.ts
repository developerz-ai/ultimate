// XML/HTML escaping and tag emission. One implementation, because a sitemap, a
// feed, and a <head> tag all fail the same way on an unescaped ampersand.

const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/**
 * The characters XML 1.0 excludes from `Char`: the C0 controls other than tab, LF and CR, and the
 * two non-characters at the end of the BMP.
 *
 * They are dropped rather than escaped because XML 1.0 offers no way to write one — `&#1;` is
 * illegal for exactly the same reason the raw byte is, so an emitter's only total move is to omit
 * it. And it has to happen HERE, in the escaper every element, attribute and CDATA section goes
 * through: one such byte in one `FeedItem` title makes the whole document not well-formed, and a
 * reader answers that with "invalid XML" rather than with the 49 items it could have parsed. A
 * scraped title, a paste out of a word processor and a `\x00` a `text` column stored without
 * complaint all produce one.
 */
// The same exemption `@ultimat3/core`'s `error-render.ts` and `@ultimat3/schema`'s `errors.ts`
// take, for the same reason.
// biome-ignore lint/suspicious/noControlCharactersInRegex: naming them is the point.
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/** Never a surrogate range: an astral character is a legal PAIR, and half of one is worse. */
const legal = (value: string): string => value.replace(ILLEGAL_XML, '');

export function escapeXml(value: string): string {
  return legal(value).replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}

/** Attribute values only ever need these three; apostrophes stay readable. */
export function escapeAttribute(value: string): string {
  return legal(value).replace(/[&<>"]/g, (char) => XML_ESCAPES[char] ?? char);
}

export function xmlElement(name: string, text: string): string {
  return `<${name}>${escapeXml(text)}</${name}>`;
}

/** CDATA suspends MARKUP, never the character rule — `legal` applies here exactly as above. */
export function cdata(value: string): string {
  return `<![CDATA[${legal(value).replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

export function attributes(attrs: Readonly<Record<string, string>>): string {
  return Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
    .join('');
}

/**
 * Join a base URL and a path without producing `//` or dropping a segment.
 *
 * A trailing slash the PATH declares is kept: `/blog/` and `/blog` are different resources, and
 * this builds every `<loc>` (`sitemap.ts`) and every canonical (`meta.ts`), so stripping it made a
 * trailing-slash site publish URLs that redirect. Only the bare-root join — `''` or `'/'` — has
 * nothing to keep, and it collapses to the base.
 */
export function absoluteUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  const base = baseUrl.replace(/\/+$/, '');
  const rest = path.replace(/^\/+/, '');
  return rest === '' ? base : `${base}/${rest}`;
}
