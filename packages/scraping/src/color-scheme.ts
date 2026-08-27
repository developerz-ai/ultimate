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
 * The set is closed at THREE. `'light'` and `'dark'` are CSS's own values; `'no-preference'` is
 * this vocabulary's way of saying **clear the override**, and it earns its place because without
 * it a preference, once set, is permanent for the session.
 *
 * It is a CLEAR and not a value, and the difference is measured. CDP's `Emulation.setEmulatedMedia`
 * treats an explicit `prefers-color-scheme: no-preference` as an OVERRIDE and an EMPTY feature list
 * as a reset, so `colorSchemeFeatures` sends the empty list. On Chrome 150 headless the two are
 * observationally identical — after either, `(prefers-color-scheme: dark)` is false,
 * `(prefers-color-scheme: light)` is true, and `(prefers-color-scheme: no-preference)` is false,
 * which is also what an untouched page answers. They diverge on a browser that HAS a real
 * preference: the override forces the light-equivalent answer, while the reset gives the machine's
 * own back — and "the launcher's default" is what this value promises.
 *
 * `no-preference` was dropped from the `prefers-color-scheme` media query in 2020, which is why
 * the third row above is false in every one of those readings. It is a control word here, never a
 * query a stylesheet can match.
 */
export const COLOR_SCHEMES = ['light', 'dark', 'no-preference'] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

/** CSS's own feature name, and CDP's. One constant, because two spellings is a silent no-op. */
export const COLOR_SCHEME_FEATURE = 'prefers-color-scheme';

export function isColorScheme(value: unknown): value is ColorScheme {
  return typeof value === 'string' && COLOR_SCHEMES.includes(value as ColorScheme);
}

/**
 * The CDP feature list for one scheme — the ONE place the clear is spelled, so a driver and a fake
 * cannot disagree about what `'no-preference'` means.
 */
export const colorSchemeFeatures = (
  scheme: ColorScheme,
): readonly { readonly name: string; readonly value: string }[] =>
  scheme === 'no-preference' ? [] : [{ name: COLOR_SCHEME_FEATURE, value: scheme }];
