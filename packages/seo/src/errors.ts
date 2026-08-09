// @ultimat3/seo error codes. SEO in Ultimate is enforced, not documented: these
// are build errors, so every one names the exact route file and the exact fix.

import { registerErrorCodes, UltimateError } from '@ultimat3/core';

export const SEO_ERROR_CODES = {
  metaMissing: 'X_SEO_META_MISSING',
  duplicateMeta: 'X_SEO_DUPLICATE_META',
  metaTooLong: 'X_SEO_META_TOO_LONG',
  canonicalMismatch: 'X_SEO_CANONICAL_MISMATCH',
  ldInvalid: 'X_LD_INVALID',
  budgetExceeded: 'X_BUDGET_EXCEEDED',
  sitemapTooLarge: 'X_SITEMAP_TOO_LARGE',
} as const;

export type SeoErrorCode = (typeof SEO_ERROR_CODES)[keyof typeof SEO_ERROR_CODES];

registerErrorCodes({
  X_SEO_META_MISSING: { title: 'a site/ route is missing required metadata' },
  X_SEO_DUPLICATE_META: { title: 'two routes share a title or description' },
  X_SEO_META_TOO_LONG: { title: 'title or description exceeds what search results render' },
  X_SEO_CANONICAL_MISMATCH: { title: 'canonical URL does not match the route path' },
  X_LD_INVALID: { title: 'JSON-LD node is missing a required schema.org field' },
  X_BUDGET_EXCEEDED: { title: 'route exceeded its performance budget' },
  X_SITEMAP_TOO_LARGE: { title: 'sitemap exceeds the 50,000-entry protocol limit' },
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

export function budgetExceeded(
  route: string,
  file: string,
  metric: string,
  limit: number,
  actual: number,
  unit: string,
): SeoError {
  return new SeoError({
    code: SEO_ERROR_CODES.budgetExceeded,
    cause: `${route} (${file}) ${metric} is ${actual}${unit}, budget is ${limit}${unit}`,
    fix: `x analyze ${route} --json   # then trim, or raise budget.${metric} in ${file}`,
    meta: { route, file, metric, limit, actual, unit },
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
 * The vocabulary a **user-supplied** `ImageTransformDriver` uses to report a capability it
 * does not implement — a CDN driver with no blur endpoint, say. `builtinImageDriver` needs it
 * for nothing; it implements both entry points. Exported so a partial driver fails with a code
 * and a fix instead of returning an unoptimised original and calling that a transform.
 */
export function notImplementedDriver(driver: string, capability: string): SeoError {
  return new SeoError({
    code: 'X_NOT_IMPLEMENTED',
    cause: `the ${driver} image driver does not implement ${capability} yet`,
    fix:
      `implement ${capability} in the ${driver} driver, or pass builtinImageDriver({ read }) ` +
      'instead — it encodes png and jpeg with no dependencies',
    meta: { driver, capability },
  });
}
