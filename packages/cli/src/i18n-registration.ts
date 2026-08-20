// Every finding about an app's strings, and the one composition `x i18n check` and `x verify`'s
// `i18n` step both report — two callers, one answer, so the command and the gate can never
// disagree. The runtime half is here because nothing else could ask it: `i18n-audit.ts` compares
// source against files on disk and was green for every string of a shipped app whose catalog
// module nothing imported (issue #249).

import type { Catalog, Extraction, ExtractReport, Locale } from '@ultimat3/i18n';
import {
  auditCatalogs,
  catalogFor,
  catalogMissingKeys,
  catalogRegistrationGaps,
  catalogsNeverRegistered,
  catalogUnregistered,
  registeredLocales,
} from '@ultimat3/i18n';
import { loadApp } from './app-load';
import { auditApp } from './i18n-audit';
import type { Finding } from './output';
import { findingFrom } from './output';
import { catalogPath } from './templates/locales';

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
  const findings: Finding[] = gaps.map((gap) => ({
    ...findingFrom(catalogUnregistered(gap)),
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
 * The file half: a key source uses that a locale's catalog does not define. Built here rather than
 * in `cmd-i18n.ts` because `x verify`'s `i18n` step reports the same finding, and a second
 * construction of it is two renderers of one fact waiting to drift.
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
  return [...missingKeyFindings(report), ...registration.findings];
}
