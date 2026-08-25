// A string-to-string map that came out of the BROWSER — an element's attributes, `localStorage` —
// read permissively and onto a null prototype. One reader, because the two call sites had the same
// bug and would have been fixed twice.

/**
 * The browser's own keys, READ rather than refused by name.
 *
 * `t.record()` refuses `__proto__`, `constructor` and `prototype` (`packages/schema/src/
 * validators.ts`), which is exactly right where a record's keys are a caller's — a request body —
 * and exactly wrong here. `<div constructor="Foo">` is legal HTML that real build tooling emits,
 * and `localStorage.setItem('constructor', …)` is legal storage; both threw `X_VALIDATION_FAILED`
 * out of a page read with nothing wrong with it, and `cdp-target.ts`'s `guard()` then re-labelled
 * that `X_SCRAPE_BROWSER_UNREACHABLE`, which is registered RETRYABLE — five browser launches and
 * five arrivals at a login over one benign attribute.
 *
 * The null prototype is the other half, and it is why this is not merely a looser schema: on a
 * `{}` literal `attrs['toString']` answers an `Object.prototype` function the page never sent, and
 * `attrs['__proto__'] = value` files no own key at all. `Readonly<Record<string, string>>` would
 * be a lie the caller cannot see through either way. Same construction and the same argument as
 * `http.ts`'s `headerRecord` makes for response headers, one leg over.
 *
 * TOTAL, deliberately: a non-object answers an empty map and a non-string value is skipped. The
 * caller is a driver reading a live browser, and a refusal from here is read by everything above
 * it as a browser that went away.
 */
export function browserRecord(value: unknown): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  if (typeof value !== 'object' || value === null) return out;
  // Assignment, not `defineProperty`: with no prototype there is no inherited `__proto__` setter
  // to swallow the write, so a key spelled `__proto__` files as an ordinary own key.
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}
