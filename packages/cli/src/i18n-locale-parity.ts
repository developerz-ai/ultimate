// The two rules a locale's catalog must satisfy against the reference locale's: the same
// interpolation slots, and no untranslated copy of the reference's string. Both already hold at the
// APP level (examples/dummy's catalog test asserts them over its en/es catalogs); this module is
// the same rule as a finding, so a broken locale fails the gate instead of shipping.

import { DEFAULT_LOCALE, ERROR_DOCS_URL } from '@ultimat3/core';
import type { Catalog, Locale } from '@ultimat3/i18n';
import { isMiss, placeholdersOf } from '@ultimat3/i18n';
import type { Finding } from './output';
import { catalogPath } from './templates/locales';

/**
 * The length above which two identical values are a copy rather than a name. `Postly`, `Free` and
 * `Blog` read the same in every language; a sentence of 25 characters does not, and shipping it
 * untranslated is the defect this rule exists to name.
 */
const COPY_LENGTH = 24;

/** The slots, as `{name}` — the way a cause and a fix name them. */
const shownSlots = (slots: readonly string[]): string =>
  slots.map((slot) => `{${slot}}`).join(', ');

/** The slots as the loud miss `interpolate` renders for each of them. */
const shownMisses = (slots: readonly string[]): string =>
  slots.map((slot) => `⟦${slot}⟧`).join(', ');

/** A value, capped: a cause is one line, and a 300-character string is not a cause. */
const shownValue = (value: string): string =>
  value.length > 60 ? `${value.slice(0, 60)}…` : value;

/**
 * Every defect one locale's catalog holds against the reference's, as findings.
 *
 * Pure: catalogs in, findings out. A slot is read with `placeholdersOf` — @ultimat3/i18n's one
 * definition, the same function `interpolate` substitutes by — because a second regex here could
 * only ever disagree with the runtime about what a slot is.
 *
 * The reference is `en` — core's `DEFAULT_LOCALE`, never a second `'en'` spelled here. An app
 * that ships no `en` catalog is not compared at all: there is no reference to compare against, and
 * a rule with nothing to compare is noise on a healthy app.
 */
export function localeParityFindings(
  catalogs: Readonly<Record<Locale, Catalog>>,
): readonly Finding[] {
  const reference = catalogs[DEFAULT_LOCALE];
  if (reference === undefined) return [];
  const findings: Finding[] = [];
  for (const locale of Object.keys(catalogs).sort()) {
    if (locale === DEFAULT_LOCALE) continue;
    const catalog = catalogs[locale];
    if (catalog === undefined) continue;
    for (const key of Object.keys(reference).sort()) {
      const value = reference[key];
      const translated = catalog[key];
      // Only a key BOTH define: a key one catalog holds alone is a MISSING key, and that is
      // `X_CATALOG_MISSING_KEYS`'s finding. Reporting it here too would be one defect under two
      // codes, and the second code's repair is not the first one's.
      if (value === undefined || translated === undefined) continue;
      findings.push(...keyFindings(locale, key, value, translated));
    }
  }
  return findings;
}

/**
 * The findings for one key, in one order: the slots the locale adds, the slots it drops, and the
 * copy. A slot mismatch is TWO findings, because the two repairs differ — one is a rename, the
 * other an addition — and a single cause could only name one of them.
 *
 * Every `fix:` opens with the command and names the edit behind a `#`: a fix is pasted from its
 * first character, so a sentence the reader has to translate first is what the `fix-prose`
 * ratchet refuses.
 */
function keyFindings(
  locale: Locale,
  key: string,
  reference: string,
  translated: string,
): readonly Finding[] {
  const path = catalogPath(locale);
  // A loud miss (`⟦key⟧`) is a placeholder, not a translation, and it carries no slot of its own:
  // a slot comparison across it blames the marker — `x i18n sync` seeds one into every key
  // nobody has translated — and prints a fix ("add {name}") that edits the placeholder. The hole
  // is `X_CATALOG_MISSING_KEYS`'s finding, already reported: a second code for one defect, with a
  // repair that would destroy the marker. So the comparison waits for a real string on both sides.
  const comparable = !isMiss(reference) && !isMiss(translated);
  const referenceSlots = placeholdersOf(reference);
  const translatedSlots = placeholdersOf(translated);
  const extra = translatedSlots.filter((slot) => !referenceSlots.includes(slot));
  const missing = referenceSlots.filter((slot) => !translatedSlots.includes(slot));
  const findings: Finding[] = [];

  if (comparable && extra.length > 0) {
    findings.push({
      code: 'X_CATALOG_SLOT_MISMATCH',
      cause: `${path} defines "${key}" with ${shownSlots(extra)}, which ${catalogPath(DEFAULT_LOCALE)} does not — interpolate substitutes by name, so ${locale} renders ${shownMisses(extra)}`,
      fix:
        referenceSlots.length === 0
          ? `x i18n check --json   # remove ${shownSlots(extra)} from "${key}" in ${path}`
          : `x i18n check --json   # use ${shownSlots(referenceSlots)} instead of ${shownSlots(extra)} in "${key}" in ${path}`,
      docs: ERROR_DOCS_URL,
      at: path,
      meta: { locale, key },
    });
  }

  if (comparable && missing.length > 0) {
    findings.push({
      code: 'X_CATALOG_SLOT_MISMATCH',
      cause: `${catalogPath(DEFAULT_LOCALE)} defines "${key}" with ${shownSlots(missing)}, which ${path} does not — the value it carries never renders in ${locale}`,
      fix: `x i18n check --json   # add ${shownSlots(missing)} to "${key}" in ${path}`,
      docs: ERROR_DOCS_URL,
      at: path,
      meta: { locale, key },
    });
  }

  // A value longer than the bar that is byte-identical to the reference's is a copy nobody
  // translated. A marker is NOT a copy: `⟦key⟧` is the loud miss `X_CATALOG_MISSING_KEYS` already
  // reports, and a placeholder seeded into two locales would otherwise be one hole under two
  // codes. `isMiss` is the framework's own predicate for that marker.
  if (translated === reference && reference.length > COPY_LENGTH && !isMiss(reference)) {
    findings.push({
      code: 'X_CATALOG_UNTRANSLATED',
      cause: `${path} defines "${key}" exactly as ${catalogPath(DEFAULT_LOCALE)} does ("${shownValue(reference)}") — ${reference.length} characters, so ${locale} reads the reference's sentence instead of its own`,
      fix: `x i18n check --json   # translate "${key}" in ${path}`,
      docs: ERROR_DOCS_URL,
      at: path,
      meta: { locale, key },
    });
  }

  return findings;
}
