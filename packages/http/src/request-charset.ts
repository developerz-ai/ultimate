// Single responsibility: the decoder a `text/*` body is read with — the `charset` its
// `content-type` declares (RFC 9110 §8.3.2), UTF-8 when it declares none. JSON and forms are
// UTF-8 by their own specs and never come here.

/**
 * The encodings a body may declare, as `TextDecoder` names them once a label resolves — so every
 * WHATWG alias of one (`latin1`, `iso-8859-1`, `ascii` → `windows-1252`) is honoured, and no other.
 * Stateless and single-meaning on purpose: a request choosing `iso-2022-jp`, `gb18030` or
 * `x-user-defined` decodes to text that disagrees with anything inspecting the raw bytes.
 */
export const BODY_CHARSETS = ['utf-8', 'utf-16le', 'utf-16be', 'windows-1252'] as const;

const allowed: ReadonlySet<string> = new Set(BODY_CHARSETS);

/** `undefined` is a label outside `BODY_CHARSETS`: the caller refuses the body, never guesses. */
export function textDecoderFor(contentType: string): TextDecoder | undefined {
  const label = charsetOf(contentType);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label ?? 'utf-8');
  } catch {
    // `RangeError` is the decoder's only answer to an unknown label, and the label is the
    // caller's own header, so the refusal names it and the throwable carries nothing more.
    return undefined;
  }
  return allowed.has(decoder.encoding) ? decoder : undefined;
}

/** The `charset` parameter, unquoted; `undefined` when the header names none. */
export function charsetOf(contentType: string): string | undefined {
  for (const param of contentType.split(';').slice(1)) {
    const at = param.indexOf('=');
    if (at === -1 || param.slice(0, at).trim().toLowerCase() !== 'charset') continue;
    const value = param.slice(at + 1).trim();
    const unquoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
    return unquoted ? value.slice(1, -1) : value;
  }
  return undefined;
}
