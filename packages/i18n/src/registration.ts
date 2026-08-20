// Whether the catalogs an app SHIPS are the catalogs the running app READS. The audit in
// `extract.ts` compares source against files on disk and can be green while the registry is empty
// (issue #249) — registration is a side effect of importing a module, so only the registry knows.

import { type Catalog, missingFrom } from './catalog';
import { catalogFor } from './context';
import { catalogUnregistered } from './errors';
import type { Locale } from './locales';

/** One locale's shipped catalog measured against the registry the running app reads. */
export interface CatalogRegistrationGap {
  readonly locale: Locale;
  /** How many keys the shipped catalog defines — the denominator the cause reports against. */
  readonly shipped: number;
  /** Shipped keys the registry cannot answer, sorted. Every one renders a loud miss. */
  readonly missing: readonly string[];
}

/**
 * Per locale, because the registry is: a key registered under `en` does not answer a request that
 * resolved to `es`, and a set-of-all-keys check would call an `es`-only app wired.
 *
 * The caller supplies what the app ships — the parsed `packages/i18n/catalogs/*.json` for a CLI
 * check, `CatalogSet.catalogs` for a boot assertion. This package never reads a file.
 */
export function catalogRegistrationGaps(
  shipped: Readonly<Record<Locale, Catalog>>,
): readonly CatalogRegistrationGap[] {
  const gaps: CatalogRegistrationGap[] = [];
  for (const locale of Object.keys(shipped).sort()) {
    const catalog = shipped[locale];
    if (catalog === undefined) continue;
    const missing = missingFrom(catalog, catalogFor(locale));
    if (missing.length === 0) continue;
    gaps.push({ locale, shipped: Object.keys(catalog).length, missing });
  }
  return gaps;
}

/**
 * The boot-time half: throw on the first locale that did not reach the registry. One locale per
 * throw and not a joined summary, because the `fix:` is the same edit for all of them and a cause
 * naming five locales is one nobody reads to the end.
 */
export function assertCatalogsRegistered(shipped: Readonly<Record<Locale, Catalog>>): void {
  const gap = catalogRegistrationGaps(shipped)[0];
  if (gap === undefined) return;
  throw catalogUnregistered(gap);
}
