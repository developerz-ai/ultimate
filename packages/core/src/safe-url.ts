// Single responsibility: deciding whether a URL is safe to put in a URL-bearing HTML attribute.
// It lives in core because the packages that need it — `@ultimat3/render` (the SSR attribute
// writer) and `@ultimat3/ui` (an anchor whose href comes off a row) — are tiers 4 and 5 and one
// cannot import the other; core is the lowest tier both reach. Same reason as `timing-safe-equal`.

/** The attributes a browser will FOLLOW. A scheme in any of them is executable. */
export const URL_ATTRIBUTES: readonly string[] = ['href', 'src', 'action', 'formaction'];

/**
 * `javascript:` and `vbscript:` are the two that execute; everything not on this list is refused
 * rather than judged, because "which exotic scheme is harmless" is a question that gets a wrong
 * answer once and then ships. The five here are the ones an anchor in an app actually carries —
 * a refusal is SILENT (no attribute at all), so a scheme missing from this list is a dead link,
 * which is why the list is the realistic set rather than the minimal one.
 */
const SAFE_SCHEMES: readonly string[] = ['http:', 'https:', 'mailto:', 'tel:', 'sms:'];

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** The prefix the `src` exemption is written against — see `safeUrl`'s last branch. */
const DATA_IMAGE = 'data:image/';

/**
 * The value to emit, or `null` when the attribute must not be emitted at all. An anchor with no
 * `href` is inert and still renders its text, which is strictly better than a live one nobody
 * checked.
 *
 * `attribute` is compared lowercased by the caller's own table, so pass the HTML spelling.
 */
export function safeUrl(value: string, attribute: string): string | null {
  // A browser deletes TAB, CR and LF anywhere in a URL and trims leading C0 controls and spaces
  // before parsing it, so `java\tscript:alert(1)` is `javascript:` by the time it is followed —
  // the scheme has to be read off the stripped form, never off the raw one.
  // Built by code point rather than a regex character class because Biome refuses a control
  // character in a pattern - and it is right to: this is the one place that wants them named.
  const stripped = [...value]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code > 0x20 && code !== 0x7f;
    })
    .join('');
  const matched = SCHEME.exec(stripped);
  // No scheme at all: relative, absolute-path, protocol-relative, query or fragment. Nothing here
  // can execute, and refusing them would refuse most of the links an app writes.
  if (matched === null) return value;
  const scheme = matched[0].toLowerCase();
  if (SAFE_SCHEMES.includes(scheme)) return value;
  // The one data URL kept, and only where the bytes are RENDERED rather than navigated to: the
  // framework's own blur placeholder is a `data:image/webp`. In an `href` a data URL is a document
  // that runs on nothing but is still a phishing surface, so it is refused there.
  //
  // `image/svg+xml` is carved back OUT of that exemption, because an SVG is not an image the way
  // the other four are — it is a script document. `@ultimat3/render` routes EVERY `src` through
  // here, not only an `<img>`'s, so `<iframe src="data:image/svg+xml,<svg><script>…">` executed
  // the identical string this function refuses one attribute over in `href`.
  // `@ultimat3/storage` deletes the same type from its default upload allowlist for the same
  // reason. Read off `stripped`, never the raw value: a browser deletes the control characters
  // before it parses the media type too.
  if (attribute === 'src' && stripped.slice(0, DATA_IMAGE.length).toLowerCase() === DATA_IMAGE) {
    return stripped.slice(DATA_IMAGE.length).toLowerCase().startsWith('svg') ? null : value;
  }
  return null;
}
