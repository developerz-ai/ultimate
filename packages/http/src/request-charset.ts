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

/**
 * `; charset = value` or `; charset="value"`, any case. One match over the parameters, never a
 * `name=value` walk of its own: that walk is the cookie reader's shape (`readCookie`, in core).
 * Linear: each quantifier is bounded by a class the next token cannot start with.
 */
const CHARSET_PARAM = /;\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i;

/** The `charset` parameter, unquoted; `undefined` when the header names none. */
export function charsetOf(contentType: string): string | undefined {
  const match = CHARSET_PARAM.exec(contentType);
  if (match === null) return undefined;
  return match[1] ?? match[2];
}
