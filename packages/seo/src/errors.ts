// @ultimat3/seo error codes. SEO in Ultimate is enforced, not documented: these
// are build errors, so every one names the exact route file and the exact fix.

import { registerErrorCodes, UltimateError } from '@ultimat3/core';
// errors.ts <-> images.ts: images.ts throws imageQueryInvalid() and this file spells its fix
// using images.ts's IMAGE_QUERY_KEYS. Safe like core's errors.ts <-> error-codes.ts cycle:
// nothing at this module's top level reads the import, only the factory body below does, and by
// the time that runs both modules have finished loading.
import { IMAGE_QUERY_KEYS } from './images';

export const SEO_ERROR_CODES = {
  metaMissing: 'X_SEO_META_MISSING',
  duplicateMeta: 'X_SEO_DUPLICATE_META',
  metaTooLong: 'X_SEO_META_TOO_LONG',
  canonicalMismatch: 'X_SEO_CANONICAL_MISMATCH',
  ldInvalid: 'X_LD_INVALID',
  sitemapTooLarge: 'X_SITEMAP_TOO_LARGE',
  imageQueryInvalid: 'X_IMAGE_QUERY_INVALID',
} as const;

export type SeoErrorCode = (typeof SEO_ERROR_CODES)[keyof typeof SEO_ERROR_CODES];

/**
 * Every code here is seo's own, so the registration is unconditional and atomic — a collision must
 * surface as X_ERROR_CODE_DUPLICATE, never as a first-writer-wins title. A performance budget is
 * deliberately not among them: `@ultimat3/render` owns `X_BUDGET_EXCEEDED` and `@ultimat3/cli`'s
 * `checkBudgets` is the gate that throws it, so seo naming the same condition was a second code
 * for one fault whose only thrower was its own test. `errors.test.ts` pins the set.
 * `X_NOT_IMPLEMENTED` and `X_IMAGE_UNSUPPORTED` are core's; `SeoError` throws them, untitled here.
 */
registerErrorCodes({
  X_SEO_META_MISSING: { title: 'a site/ route is missing required metadata' },
  X_SEO_DUPLICATE_META: { title: 'two routes share a title or description' },
  X_SEO_META_TOO_LONG: { title: 'title or description exceeds what search results render' },
  X_SEO_CANONICAL_MISMATCH: { title: 'canonical URL does not match the route path' },
  X_LD_INVALID: { title: 'JSON-LD node is missing a required schema.org field' },
  X_SITEMAP_TOO_LARGE: { title: 'sitemap exceeds the 50,000-entry protocol limit' },
  X_IMAGE_QUERY_INVALID: { title: 'an image transform query parameter is present but unusable' },
});

export interface SeoErrorInit {
  readonly code: SeoErrorCode | 'X_NOT_IMPLEMENTED';
  readonly cause: string;
  readonly fix: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export class SeoError extends UltimateError {
  override readonly name: string = 'SeoError';

  constructor(init: SeoErrorInit) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
      docs: `https://ultimate.dev/errors/${init.code}`,
      meta: init.meta,
    });
  }
}

/** A `site/` route without a title or description. Names the file, not the URL. */
export function metaMissing(file: string, path: string, field: string): SeoError {
  return new SeoError({
    code: SEO_ERROR_CODES.metaMissing,
    cause: `${file} (route "${path}") has no meta.${field}`,
    fix: `add ${field} to defineRoute({ meta }) in ${file}`,
    meta: { file, path, field },
  });
}

export function duplicateMeta(field: string, value: string, files: readonly string[]): SeoError {
  return new SeoError({
    code: SEO_ERROR_CODES.duplicateMeta,
    cause: `${files.length} routes share the same ${field} ${JSON.stringify(value)}: ${files.join(', ')}`,
    fix: `give each route a unique ${field} in its defineRoute({ meta })`,
    meta: { field, value, files },
  });
}

export function metaTooLong(file: string, field: string, length: number, max: number): SeoError {
  return new SeoError({
    code: SEO_ERROR_CODES.metaTooLong,
    cause: `${file} has a ${length}-character ${field}; search results truncate past ${max}`,
    fix: `shorten meta.${field} in ${file} to <= ${max} characters`,
    meta: { file, field, length, max },
  });
}

export function canonicalMismatch(file: string, canonical: string, expected: string): SeoError {
  return new SeoError({
    code: SEO_ERROR_CODES.canonicalMismatch,
    cause: `${file} declares canonical ${canonical} but the route resolves to ${expected}`,
    fix: `set meta.canonical to ${expected} in ${file}, or delete it and let the route supply it`,
    meta: { file, canonical, expected },
  });
}

export function ldInvalid(type: string, field: string, hint: string): SeoError {
  return new SeoError({
    code: SEO_ERROR_CODES.ldInvalid,
    cause: `ld.${type}() received an empty or missing "${field}" (${hint})`,
    fix: `provide a non-empty ${field} to ld.${type}(); it is required by schema.org`,
    meta: { type, field },
  });
}

export function sitemapTooLarge(count: number, max: number): SeoError {
  return new SeoError({
    code: SEO_ERROR_CODES.sitemapTooLarge,
    cause: `sitemap index would hold ${count} sitemaps; the protocol limit is ${max}`,
    fix: 'exclude non-indexable routes with noindex, or shard the site across hostnames',
    meta: { count, max },
  });
}

/**
 * `parseImageQuery`'s only refusal: a `?w=`/`?q=`/`?f=` value present but not usable — serving
 * the untransformed original against a URL that asked for a size would be the layout shift this
 * contract exists to prevent, so an unusable value throws instead of falling back silently. A
 * format string naming no *real* encoder is a different failure (`image-driver.ts`'s
 * `X_IMAGE_UNSUPPORTED`); this code never covers it.
 *
 * The `fix` is written as an inline ternary, not a helper call, so the `errors` gate step can
 * still read each branch as a literal — a `fix` computed behind a function call has nothing for
 * a static scan to check, and the gate would silently wave the whole thing through.
 */
export function imageQueryInvalid(param: string, value: string, reason: string): SeoError {
  return new SeoError({
    code: SEO_ERROR_CODES.imageQueryInvalid,
    cause: `?${param}=${value} is not usable: ${reason}`,
    fix:
      param === IMAGE_QUERY_KEYS.quality
        ? `request ?${IMAGE_QUERY_KEYS.quality}=75 — a whole number from 1 to 100`
        : param === IMAGE_QUERY_KEYS.format
          ? `request ?${IMAGE_QUERY_KEYS.format}=webp — a non-empty format name`
          : `request ?${IMAGE_QUERY_KEYS.width}=640 with a positive integer width`,
    meta: { param, value, reason },
  });
}

/**
 * The vocabulary a **user-supplied** `ImageTransformDriver` uses to report a capability it
 * does not implement — a CDN driver with no blur endpoint, say. `builtinImageDriver` needs it
 * for nothing; it implements both entry points. Exported so a partial driver fails with a code
 * and a fix instead of returning an unoptimised original and calling that a transform.
 *
 * `at` is the driver's own module path — pass `import.meta.path`. It is required because
 * `driver` is a display name, and a fix an agent cannot open is not a fix.
 */
export function notImplementedDriver(driver: string, capability: string, at: string): SeoError {
  return new SeoError({
    code: 'X_NOT_IMPLEMENTED',
    cause: `the ${driver} image driver does not implement ${capability} yet`,
    fix:
      `implement ${capability} in ${at}, or swap the driver for builtinImageDriver({ read }) ` +
      '— png and jpeg, no dependencies — then run: x verify --json',
    meta: { driver, capability, at },
  });
}
