// Every finding about an app's strings, and the one composition `x i18n check` and `x verify`'s
// `i18n` step both report — two callers, one answer, so the command and the gate can never
// disagree. The runtime half is here because nothing else could ask it: `i18n-audit.ts` compares
// source against files on disk and was green for every string of a shipped app whose catalog
// module nothing imported (issue #249).

// why: Bun ships no path API, so `join` is the only way to reach the app's own i18n module on
// the host's separator.
import { join } from 'node:path';
import type { Catalog, Extraction, ExtractReport, Locale } from '@ultimat3/i18n';
import {
  auditCatalogs,
  catalogFor,
  catalogMissingKeys,
  catalogRegistrationGaps,
  catalogsNeverRegistered,
  catalogUnregistered,
  pluralVariantsOf,
  registeredLocales,
} from '@ultimat3/i18n';
import { loadApp } from './app-load';
import { auditApp } from './i18n-audit';
import { I18N_INDEX_PATH } from './i18n-index';
import type { Finding } from './output';
import { findingFrom } from './output';
import { CATALOG_ROOT, catalogPath } from './templates/locales';

/**
 * What this check needs of a boot. The seam is injected so a fixture can be exactly "the app
 * loaded and registered nothing" — the shipped shape of the bug — without a temp directory that
 * can resolve `@ultimat3/*`. `loadApp` is the production value, and it is the same call
 * `serveApp` makes: asking a different loader than the server uses would prove nothing.
 */
export type AppLoader = (root: string) => Promise<{
  readonly findings: readonly Finding[];
  readonly defaultLocale: string;
}>;

export interface RegistrationInput {
  readonly root: string;
  /** The catalogs on disk, parsed — `packages/i18n/catalogs/*.json`. */
  readonly catalogs: Readonly<Record<Locale, Catalog>>;
  readonly extraction: Extraction;
  readonly ignoreUnused: readonly string[];
  readonly load?: AppLoader;
}

export interface RegistrationReport {
  readonly ok: boolean;
  readonly findings: readonly Finding[];
  /** Keys that would render a loud miss because registration never happened. */
  readonly unregistered: number;
  /** How many locales are affected — one row of the summary's "across N locale(s)". */
  readonly locales: number;
  /** Which shipped locales the registry cannot fully answer — the `registered` column's `no`. */
  readonly unregisteredLocales: readonly Locale[];
  /** Every locale the registry holds after the load, sorted. Empty is not possible in a real
   * boot: the framework's own catalog is the base layer, so `['en']` is the floor. */
  readonly registered: readonly Locale[];
}

/**
 * The app ships nothing on disk, so there is no file to diff — the only evidence left is whether
 * the keys source actually uses resolve. Audited through `auditCatalogs` rather than a fresh
 * `hasOwn` loop, because a plural family is defined as `n_one`/`n_other` and a bare lookup of the
 * stem `n` would report every plural in the app as unresolved.
 */
function unresolvedUsedKeys(input: RegistrationInput, locale: Locale): readonly string[] {
  const report = auditCatalogs({
    extraction: input.extraction,
    catalogs: { [locale]: catalogFor(locale) },
    ignoreUnused: input.ignoreUnused,
  });
  return report.locales[0]?.missing ?? [];
}

export async function checkRegistration(input: RegistrationInput): Promise<RegistrationReport> {
  // Importing the app's modules IS the registration, in this process exactly as in the server's.
  const app = await (input.load ?? loadApp)(input.root);

  const gaps = catalogRegistrationGaps(input.catalogs);
  const index = await indexSource(input.root);
  const findings: Finding[] = gaps.map((gap) => ({
    ...findingFrom(catalogUnregistered(gap)),
    ...unregisteredFix(gap.locale, index),
    at: catalogPath(gap.locale),
  }));
  let unregistered = gaps.reduce((sum, gap) => sum + gap.missing.length, 0);
  let locales = gaps.length;

  if (Object.keys(input.catalogs).length === 0) {
    const unresolved = unresolvedUsedKeys(input, app.defaultLocale);
    if (unresolved.length > 0) {
      findings.push(findingFrom(catalogsNeverRegistered(app.defaultLocale, unresolved)));
      unregistered += unresolved.length;
      locales += 1;
    }
  }

  return {
    ok: findings.length === 0,
    // The load's own findings ride along ONLY when something is unregistered, and that condition is
    // the whole value: a module that would not import registers nothing, so "packages/i18n/src/
    // index.ts: SyntaxError" is the evidence for the gap above it. With every catalog registered, a
    // broken route file is not this command's business and reporting it would be noise on a pass.
    findings: findings.length === 0 ? findings : [...findings, ...app.findings],
    unregistered,
    locales,
    unregisteredLocales: gaps.map((gap) => gap.locale),
    registered: registeredLocales(),
  };
}

/**
 * `packages/i18n/src/index.ts` as text, or `undefined` where the app has no i18n package. Read
 * here and nowhere lower down: `@ultimat3/i18n` states that it never reads a file, and the CLI is
 * the half that knows what an app's directories are.
 */
async function indexSource(root: string): Promise<string | undefined> {
  const file = Bun.file(join(root, I18N_INDEX_PATH));
  return (await file.exists()) ? file.text() : undefined;
}

/**
 * `X_CATALOG_UNREGISTERED` is one code over two causes, and until now it printed one fix for both.
 * `@ultimat3/i18n`'s is written for the app whose `defineCatalogs()` call is in a module nothing
 * imports — "move it into packages/i18n/src/index.ts (where `x new` puts it)". For a locale added
 * by `x i18n add` the call is ALREADY there and the locale is simply not in its `locales:` map, so
 * that instruction names an edit with nothing to perform: an agent following it verbatim changes
 * nothing, re-runs, and is red again, on the command whose whole job is adding a locale (#F4).
 *
 * The condition is narrow enough that the finding never has to be argued with — the index exists,
 * and the locale's tag appears nowhere in it — and the replacement is a command that performs the
 * registration rather than describing it.
 */
export function unregisteredFix(
  locale: string,
  index: string | undefined,
): { readonly fix?: string } {
  if (index === undefined) return {};
  // The index is GENERATED (`i18nIndex`), so the one spelling that matters is the import it writes
  // — `catalogs/<tag>.json`. Matching a bare tag instead would read `en` out of the word `key` and
  // report a registered locale as unregistered, which is the direction that costs trust.
  if (index.includes(`${CATALOG_ROOT.split('/').pop() ?? 'catalogs'}/${locale}.json`)) return {};
  return {
    fix: `x i18n sync ${locale}   # re-derives ${I18N_INDEX_PATH} from the catalogs on disk`,
  };
}

/**
 * `⟦key⟧` — `@ultimat3/i18n`'s own loud miss, spelled ONCE for the whole CLI. `x i18n sync <default>`
 * writes it and the two checks below refuse it, so a second spelling would be a placeholder one
 * half of this package writes and the other half cannot see.
 */
const MISS_OPEN = '\u27E6';
const MISS_CLOSE = '\u27E7';

/** What `x i18n sync` seeds a key with when there is no catalog above it to copy a value from. */
export const loudMiss = (key: string): string => `${MISS_OPEN}${key}${MISS_CLOSE}`;

/**
 * A value that is a placeholder rather than a translation. Any `⟦…⟧`, not just `⟦<this key>⟧`:
 * an author who renames a key and leaves the old marker behind still ships a placeholder.
 */
export const isLoudMiss = (value: string | undefined): boolean =>
  value?.startsWith(MISS_OPEN) === true && value.endsWith(MISS_CLOSE);

/**
 * Whether `locale` answers `key` with a placeholder. Every spelling `definesKey` accepts is
 * checked — `pluralVariantsOf` is `@ultimat3/i18n`'s own list, the same one `auditCatalogs` uses,
 * so "defined" and "defined with a real string" can never disagree about which entries count.
 * `some`, not `every`: a plural family with one untranslated category renders `⟦items_many⟧` on
 * exactly the rows that hit it.
 */
const answersWithPlaceholder = (catalog: Catalog, key: string): boolean =>
  [key, ...pluralVariantsOf(key)].some(
    (candidate) => Object.hasOwn(catalog, candidate) && isLoudMiss(catalog[candidate]),
  );

/**
 * The audit, with every placeholder counted as the missing key it stands in for.
 *
 * `auditCatalogs` asks `Object.hasOwn` and nothing else, so a key present with ANY value is not
 * missing — including `⟦key⟧`, which is the value `x i18n sync <defaultLocale>` writes for every
 * gap it closes. Without this, following `X_CATALOG_MISSING_KEYS`'s own `fix:` turns the `i18n`
 * gate step green over strings no human has ever read: issue #249's ending, reached by running the
 * command the error recommends. The hole predates the seeding — a hand-written `"TODO"` bought the
 * same green — but one command now writes sixteen of them, so it is a hole with a shortcut to it.
 *
 * Applied HERE and not in `auditCatalogs`: `⟦…⟧` is what the CLI writes, and `@ultimat3/i18n`'s
 * audit answering "is this key defined" is a different question from "is this app shippable".
 */
export function withPlaceholdersMissing(
  report: ExtractReport,
  catalogs: Readonly<Record<Locale, Catalog>>,
): ExtractReport {
  const locales = report.locales.map((audit) => {
    const catalog = catalogs[audit.locale] ?? {};
    const known = new Set(audit.missing);
    const placeheld = report.used.filter(
      (key) => !known.has(key) && answersWithPlaceholder(catalog, key),
    );
    if (placeheld.length === 0) return audit;
    return { ...audit, missing: [...audit.missing, ...placeheld].sort() };
  });
  return { ...report, locales, ok: locales.every((audit) => audit.missing.length === 0) };
}

/**
 * The file half: a key source uses that a locale's catalog does not define, or defines with a
 * placeholder. Built here rather than in `cmd-i18n.ts` because `x verify`'s `i18n` step reports
 * the same finding, and a second construction of it is two renderers of one fact waiting to drift.
 */
export function missingKeyFindings(report: ExtractReport): readonly Finding[] {
  return report.locales
    .filter((audit) => audit.missing.length > 0)
    .map((audit) => ({
      ...findingFrom(catalogMissingKeys(audit.locale, audit.missing)),
      at: catalogPath(audit.locale),
    }));
}

/**
 * Both halves of one question — does every string this app renders resolve? — for a caller that
 * wants the verdict and not the table. `x verify`'s `i18n` step is that caller; `cmd-i18n.ts`
 * composes the same two pieces itself because it also renders per-locale rows.
 */
export async function catalogFindings(root: string): Promise<readonly Finding[]> {
  const { report, catalogs, extraction, ignoreUnused } = await auditApp(root);
  const registration = await checkRegistration({ root, catalogs, extraction, ignoreUnused });
  return [
    ...missingKeyFindings(withPlaceholdersMissing(report, catalogs)),
    ...registration.findings,
  ];
}
