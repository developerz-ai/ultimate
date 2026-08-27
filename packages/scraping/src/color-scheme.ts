// The OS-level colour preference a page is shown, and the CDP media feature that carries it.
//
// Its own module for `capture-clip.ts`'s reason: the vocabulary belongs to EVERY driver
// identically, and `target.ts` is a port declaration, which is not a place a decision lives.

/**
 * What a browser is told the user prefers — the INPUT to a theme decision, never its outcome.
 *
 * Setting `data-theme` on the document models the outcome, and the component owns that: a
 * component that resolves `'system'` itself deletes or overwrites the attribute on mount, so a
 * harness that set it is silently overruled and both themes converge on one picture. Measured on
 * `examples/dummy`'s settings island (issue #338): `<state>-light.png` and `<state>-dark.png` came
 * back byte-identical, same md5, from two addresses that really did serve different documents.
 *
 * The set is closed at THREE and matches CSS's own `prefers-color-scheme`, which has exactly these
 * values. `'no-preference'` is what a browser reports when nothing is configured, and it is the
 * one way back to the launcher's default — dropping it would make a preference, once set,
 * permanent for the session.
 */
export const COLOR_SCHEMES = ['light', 'dark', 'no-preference'] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

/** CSS's own feature name, and CDP's. One constant, because two spellings is a silent no-op. */
export const COLOR_SCHEME_FEATURE = 'prefers-color-scheme';

export function isColorScheme(value: unknown): value is ColorScheme {
  return typeof value === 'string' && COLOR_SCHEMES.includes(value as ColorScheme);
}
