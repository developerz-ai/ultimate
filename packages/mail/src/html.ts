// Single responsibility: turning untrusted values into inert HTML. Mail bodies interpolate
// user-supplied names, org names and URLs; an unescaped one is a phishing vector that also
// renders in the recipient's client forever, so escaping lives in exactly one place.

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape text content AND attribute values — the same set covers both in mail. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const SAFE_PROTOCOLS: readonly string[] = ['http:', 'https:', 'mailto:'];

/**
 * `javascript:` and `data:` hrefs are stripped rather than escaped: some clients still
 * follow them, and a link the recipient cannot trust is worse than a dead one.
 */
export function safeUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return '#';
  }
  return SAFE_PROTOCOLS.includes(parsed.protocol) ? parsed.href : '#';
}

/** `style="a:b;c:d"` from declarations, so no call site hand-builds a style attribute. */
export function styleAttr(declarations: readonly string[]): string {
  return `style="${escapeHtml(declarations.join(';'))}"`;
}
