// XML/HTML escaping and tag emission. One implementation, because a sitemap, a
// feed, and a <head> tag all fail the same way on an unescaped ampersand.

const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}

/** Attribute values only ever need these three; apostrophes stay readable. */
export function escapeAttribute(value: string): string {
  return value.replace(/[&<>"]/g, (char) => XML_ESCAPES[char] ?? char);
}

export function xmlElement(name: string, text: string): string {
  return `<${name}>${escapeXml(text)}</${name}>`;
}

export function cdata(value: string): string {
  return `<![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
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
