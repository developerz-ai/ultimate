// Single responsibility: refuse a manifest number JSON cannot write back as itself. The body is
// hashed by `canonicalJson`, which keeps `NaN`, `Infinity` and `-0` distinct, and written by
// `JSON.stringify`, which does not — so one such fact made a manifest that failed its own buildId.

import { ManifestFactInvalidError } from './errors';

/** Depth-first, in key order, so the refusal names the FIRST offending fact the file would hold. */
export function assertFiniteFacts(value: unknown, path: string): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new ManifestFactInvalidError({
        path,
        value: Object.is(value, -0) ? '-0' : String(value),
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => {
      assertFiniteFacts(item, `${path}[${String(index)}]`);
    });
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assertFiniteFacts(item, path === '' ? key : `${path}.${key}`);
  }
}
