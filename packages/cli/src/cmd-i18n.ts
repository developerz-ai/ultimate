// `x i18n check|add <locale>|sync <locale>|split [<locale>]` — the command every X_LOCALE_UNSUPPORTED,
// X_CATALOG_MISSING_KEYS and X_CATALOG_INVALID fix line already names. CLI wiring only: the
// facts come from `i18n-audit.ts`, the audit itself from `@ultimat3/i18n`'s own `auditCatalogs`.

import { DEFAULT_LOCALE } from '@ultimat3/core';
import type { Catalog } from '@ultimat3/i18n';
import { auditCatalogs, catalogFor, catalogKeys } from '@ultimat3/i18n';
import { adminKeyLabel, mountedAdminKeys } from './admin-catalog-keys';
import { loadApp } from './app-load';
import { requireAppRoot } from './app-root';
import type { CatalogLayout } from './catalog-layout';
import {
  catalogLocation,
  loadLayoutCatalogs,
  readCatalogLayout,
  writeLocaleCatalog,
} from './catalog-layout';
import { i18nSpec } from './cmd-i18n-spec';
import { runSplit } from './cmd-i18n-split';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, MissingPositionalError } from './errors';
import { auditApp, resolveDefaultLocale, scanSource, seedCatalog, syncCatalog } from './i18n-audit';
import { syncI18nIndex } from './i18n-index';
import { localeParityFindings } from './i18n-locale-parity';
import { writeNewLocale } from './i18n-new-locale';
import {
  checkRegistration,
  isLoudMiss,
  loudMiss,
  missingKeyFindings,
  unanswered,
  withPlaceholdersMissing,
} from './i18n-registration';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { quoteArg } from './shell-quote';
import { renderTable } from './table';
import { catalogPath, resolveLocales } from './templates/locales';

export { I18N_SUBCOMMANDS } from './cmd-i18n-spec';

/** `ExtractReport` is plain JSON by construction — same idiom as `cmd-registries.ts`'s `asJson`. */
const asJson = (value: object): Record<string, JsonValue> => value as Record<string, JsonValue>;

function requireLocalePositional(ctx: CommandContext, sub: string): string {
  const raw = ctx.args.positionals[0];
  if (raw === undefined) {
    // The locale is a positional. `--locale on "x i18n"` is the cause a MALFORMED one takes, from
    // the shared validator below — and there the flag name is what `resolveLocales` was told to
    // report; here there is no value at all, and naming a flag sends the retry to a flag loop.
    throw new MissingPositionalError({
      command: `i18n ${sub}`,
      positional: 'locale',
      example: `x i18n ${sub} es`,
    });
  }
  return raw;
}

/**
 * Validates + canonicalizes the positional locale — `resolveLocales`'s own BCP-47/escape checks
 * do the refusing, against this command's context rather than the generic `x g --locales` default:
 * the cause names `--locale on "x i18n"` and the fix is `x i18n add es` / `x i18n sync es`.
 */
function resolveOneLocale(ctx: CommandContext, sub: string): string {
  const raw = requireLocalePositional(ctx, sub);
  const resolved = resolveLocales([raw], {
    fix: `x i18n ${quoteArg(sub)} es`,
    command: 'i18n',
    flag: 'locale',
  });
  const locale = resolved[0];
  if (locale === undefined) {
    // Unreachable in practice — resolveLocales only returns [] for zero requested entries, and
    // this always passes exactly one. Guarded rather than cast past, for noUncheckedIndexedAccess.
    throw new BadFlagError({
      flag: 'locale',
      command: 'i18n',
      reason: 'could not resolve a locale',
    });
  }
  return locale;
}

/**
 * The admin-derived keys `locale`'s REGISTRY does not answer with a real string — the question
 * `checkRegistration` asks of the same keys, so `sync` writes and `check` counts exactly what the
 * `i18n` step refuses. Asked after `loadApp`: the registry holds the app's catalogs only then.
 */
const unansweredAdminKeys = (locale: string, keys: readonly string[]): readonly string[] =>
  unanswered(catalogFor(locale), keys);

async function runCheck(root: string): Promise<CommandResult> {
  const { report: audited, catalogs, extraction, ignoreUnused, layout } = await auditApp(root);
  // Corrected once, before anything reads it: the table's `missing` column, the summary count, the
  // findings and `--json`'s `data` are four projections of one report, and a placeholder counted in
  // only some of them is the command disagreeing with itself about the same app.
  const report = withPlaceholdersMissing(audited, catalogs);
  // The runtime question, asked after the file question and never instead of it: a catalog can be
  // complete on disk, used everywhere in source, and reach no registry at all (issue #249).
  const registration = await checkRegistration({
    root,
    catalogs,
    extraction,
    ignoreUnused,
    layout,
  });
  // The two rules only a comparison with the reference locale can see: a slot one side does not
  // have, and a string nobody translated. The same call `x verify`'s `i18n` step makes, so the
  // command and the gate answer about an app with one voice.
  const parity = localeParityFindings(catalogs, layout);
  const parityLocales = new Set(parity.map((finding) => finding.meta?.['locale'])).size;

  const findings: Finding[] = [
    ...missingKeyFindings(report, layout),
    ...registration.findings,
    ...parity,
  ];

  // Whether the LOCALE has a catalog is the wrong question — the framework's own `en` is always
  // registered, so a locale-presence column reads `yes` for an app whose every key is a loud miss.
  // The column answers the key-level one: does the registry hold what this file defines?
  const unregistered = new Set(registration.unregisteredLocales);
  const header = ['locale', 'keys', 'missing', 'unused', 'registered'];
  const rows = report.locales.map((audit) => [
    audit.locale,
    String(catalogKeys(catalogs[audit.locale] ?? {}).length),
    String(audit.missing.length),
    String(audit.unused.length),
    unregistered.has(audit.locale) ? 'no' : 'yes',
  ]);
  const lines = renderTable(header, rows).map((line) => `  ${line}`);

  for (const audit of report.locales) {
    if (audit.unused.length === 0) continue;
    lines.push(`  ${msg('cli.i18n.unused', { count: audit.unused.length, locale: audit.locale })}`);
    for (const key of audit.unused) lines.push(`    ${key}`);
  }
  if (report.dynamic.length > 0) {
    lines.push(`  ${msg('cli.i18n.dynamic', { count: report.dynamic.length })}`);
    for (const entry of report.dynamic) {
      // A multi-line argument (a ternary over string literals) is one finding, so it is one line —
      // an entry that wrapped would break the indented list it belongs to.
      const expression = entry.expression.replace(/\s+/g, ' ');
      lines.push(`    ${entry.file}:${entry.line}:${entry.column}  ${expression}`);
    }
  }

  // A key that renders a loud miss counts once, whichever half of the check found it: a missing
  // catalog entry and an entry no registry holds are the same `⟦key⟧` on the same page. The keys a
  // mounted admin derives are counted too — they fail `ok`, and a summary of "0 missing key(s)"
  // over `ok: false` sent the reader looking for a finding the count said was not there.
  const adminKeys = await mountedAdminKeys();
  const adminGaps = Object.keys(catalogs)
    .filter((locale) => !unregistered.has(locale))
    .map((locale) => ({ locale, missing: unansweredAdminKeys(locale, adminKeys).length }))
    .filter((gap) => gap.missing > 0);
  const gapLocales =
    new Set([
      ...report.locales.filter((audit) => audit.missing.length > 0).map((audit) => audit.locale),
      ...adminGaps.map((gap) => gap.locale),
    ]).size + registration.locales;
  const missingTotal =
    report.locales.reduce((sum, audit) => sum + audit.missing.length, 0) +
    adminGaps.reduce((sum, gap) => sum + gap.missing, 0) +
    registration.unregistered;
  const ok = report.ok && registration.ok && parity.length === 0;
  // The summary names the parity findings when there are any: `cli.i18n.gaps` counts MISSING KEYS,
  // so a locale whose slots drifted and whose string was never translated answered "0 missing
  // key(s) across 0 locale(s)" — a green-looking line over a red command. The missing count keeps
  // a line of its own, so neither fact is lost.
  let summary: string;
  if (parity.length > 0) {
    summary = msg('cli.i18n.parity', {
      count: parity.length,
      locales: parityLocales,
      reference: DEFAULT_LOCALE,
    });
    if (missingTotal > 0) {
      lines.push(`  ${msg('cli.i18n.gaps', { missing: missingTotal, locales: gapLocales })}`);
    }
  } else {
    summary = ok
      ? msg('cli.i18n.ok', { locales: report.locales.length, keys: report.used.length })
      : msg('cli.i18n.gaps', { missing: missingTotal, locales: gapLocales });
  }

  return {
    ok,
    command: 'i18n',
    summary,
    lines,
    findings,
    data: { ...asJson(report), ok, registered: [...registration.registered] },
  };
}

async function runAdd(root: string, ctx: CommandContext): Promise<CommandResult> {
  const locale = resolveOneLocale(ctx, 'add');
  const app = await loadApp(root);
  const layout = await readCatalogLayout(root);
  const catalogs = await loadLayoutCatalogs(root, layout);
  const from = resolveDefaultLocale(app.locales.defaultLocale, catalogs);
  const seeded = seedCatalog(from === undefined ? {} : (catalogs[from] ?? {}));
  // In the default locale's form: a split app's new locale is a directory of the same files.
  const source = from === undefined ? undefined : layout[from];
  const path = await writeNewLocale(root, locale, seeded, source);
  // The second half of adding a locale, and without it this command SHIPPED A RED GATE: the file
  // landed, `packages/i18n/src/index.ts` still said `locales: { en }`, and `x verify --only i18n`
  // answered `X_CATALOG_UNREGISTERED` with a fix naming an edit that had already been made. Same
  // writer `x g --locales` already uses, so a catalog on disk and a selectable locale can never be
  // two different sets (#F4).
  const { registered, findings: indexFindings } = await syncI18nIndex(root);

  const keys = catalogKeys(seeded).length;
  // The catalog is on disk either way, but a finding fails the run: a `packages/i18n/src/index.ts`
  // that would not import is why `from` may be the framework's `en` instead of the app's own
  // default, and an index the locale could not be registered in is a red `i18n` gate step.
  const findings = [...indexFindings, ...app.findings];
  return {
    ok: findings.length === 0,
    command: 'i18n',
    summary: msg('cli.i18n.added', { locale, keys, from: from ?? locale }),
    findings,
    // `registered` is false only for an app with no `packages/i18n` at all — a fact a caller has
    // to be able to read, because it is the one case where the locale is on disk and unselectable.
    data: { locale, from: from ?? locale, keys, path, registered },
  };
}

/**
 * `x i18n sync <defaultLocale>` merges the default locale into itself, so `added` was empty **by
 * construction** — exit 0, "0 key(s) added", and `x i18n check` still red over the same keys. That
 * command is `X_CATALOG_MISSING_KEYS`'s own `fix:`, and `i18n` is a step of the gate, so the only
 * escape left was a hand edit nothing named.
 *
 * The source of truth for the default locale is not another catalog — there is none above it — it
 * is the SOURCE: every key `t()` calls that this catalog does not define, seeded with `loudMiss`,
 * the marker `@ultimat3/i18n` already renders for an absent key. The author is then one obvious
 * edit per key from done, with each key sitting exactly where that edit goes — and the gate stays
 * RED until they make it, because `withPlaceholdersMissing` counts every one as still missing.
 *
 * The seeding and the refusal read ONE definition of the marker (`i18n-registration.ts`): two
 * spellings would be a placeholder this command writes and the gate cannot see.
 *
 * The list is the `missing` one `x i18n check` prints and `X_CATALOG_MISSING_KEYS` names, read
 * through the same two functions the check reads it through: `auditCatalogs` rather than
 * `missingFrom`, because a `pl` catalog defining `items_many` and no bare `items` is complete and a
 * plain key diff would seed a placeholder over it, then `withPlaceholdersMissing` so "missing"
 * means here exactly what it means to the gate.
 */
async function untranslatedKeys(
  root: string,
  catalogs: Readonly<Record<string, Catalog>>,
  locale: string,
): Promise<readonly string[]> {
  const extraction = await scanSource(root);
  // `reference` as `auditApp` passes it: an app whose default is not `en` is told to sync its default
  // over a key `en` holds alone, and this list is all that command can add.
  const audit = auditCatalogs({ extraction, catalogs, reference: DEFAULT_LOCALE });
  const report = withPlaceholdersMissing(audit, catalogs);
  return report.locales.find((audit) => audit.locale === locale)?.missing ?? [];
}

const placeholderCatalog = (keys: readonly string[]): Catalog =>
  Object.fromEntries(keys.map((key) => [key, loudMiss(key)]));

/**
 * The keys a mounted admin derives that `locale` does not answer — spelled in no source file, so
 * the source scan above can never seed one, and `X_CATALOG_MISSING_KEYS` names this command as the
 * fix for them all the same. The default locale gets the label `x g resource --admin` writes
 * (`adminKeyLabel`), a real string the gate accepts; any other locale gets it MARKED, a translation
 * a human still owes, exactly as a merged key is.
 */
async function adminCatalog(locale: string, seeded: boolean): Promise<Catalog> {
  const keys = unansweredAdminKeys(locale, await mountedAdminKeys());
  const label = (key: string): string =>
    seeded ? adminKeyLabel(key) : loudMiss(adminKeyLabel(key));
  return Object.fromEntries(keys.map((key) => [key, label(key)]));
}

/**
 * The admin keys just written to a second locale that the default locale's FILE lacks, written
 * there too. The default locale answers them already — the framework's own `en` holds the admin
 * chrome (`admin.brand.name`, `admin.x_jobs.title`), so its registry is green with no such key in
 * the app's catalog — and syncing only the second locale left the app's catalogs with two key sets,
 * the scaffold's own "same keys as the default" test red on the command the gate prescribed. The
 * value is the string the default locale already renders, never a marker, so its page is unchanged.
 */
async function backfillDefault(
  root: string,
  catalogs: Readonly<Record<string, Catalog>>,
  layout: CatalogLayout,
  from: string,
  adminKeys: readonly string[],
): Promise<readonly string[]> {
  const target = catalogs[from] ?? {};
  const rendered = catalogFor(from);
  const real = (key: string): string => {
    const value = rendered[key];
    return value === undefined || isLoudMiss(value) ? adminKeyLabel(key) : value;
  };
  const source = Object.fromEntries(adminKeys.map((key) => [key, real(key)]));
  const { merged, added } = syncCatalog(target, source);
  if (added.length > 0) await writeLocaleCatalog(root, from, merged, layout[from]);
  return added;
}

async function runSync(root: string, ctx: CommandContext): Promise<CommandResult> {
  const locale = resolveOneLocale(ctx, 'sync');
  const layout = await readCatalogLayout(root);
  const catalogs = await loadLayoutCatalogs(root, layout);
  const target = catalogs[locale];
  if (target === undefined) {
    throw new BadFlagError({
      flag: 'locale',
      command: 'i18n',
      reason: `no catalog for "${locale}" at ${catalogPath(locale)}`,
      fix: `x i18n add ${quoteArg(locale)}`,
    });
  }

  const app = await loadApp(root);
  const from = resolveDefaultLocale(app.locales.defaultLocale, catalogs);
  // `from === locale` is the default locale asked to sync itself, and `undefined` is an app with
  // no resolvable default at all — one branch, because both have no catalog to merge from.
  // A real merge copies the default locale's strings MARKED (`seedCatalog`, as `x i18n add` does):
  // copied bare they rendered English to every `fr` reader under a green gate.
  const seeded = from === undefined || from === locale;
  // The admin's keys first, so a value the default locale already carries for one (copied, marked)
  // wins over a label read off the key.
  const admin = await adminCatalog(locale, seeded);
  const source = {
    ...admin,
    ...(seeded
      ? placeholderCatalog(await untranslatedKeys(root, catalogs, locale))
      : seedCatalog(catalogs[from] ?? {})),
  };
  const { merged, added } = syncCatalog(target, source);
  // Into the locale's own form: a split locale's key lands in its namespace file, created if new.
  if (added.length > 0) await writeLocaleCatalog(root, locale, merged, layout[locale]);
  const adminAdded = added.filter((key) => Object.hasOwn(admin, key));
  const defaultAdded = seeded
    ? []
    : await backfillDefault(root, catalogs, layout, from, adminAdded);
  // Unconditional, and not only when keys moved: a catalog that reached disk some other way — a
  // hand-created file, a `git merge` — is exactly the unregistered locale the gate refuses, and
  // this is the command its `fix:` names. Re-deriving an index that is already correct writes the
  // same bytes.
  const { registered, findings: indexFindings } = await syncI18nIndex(root);

  const total = catalogKeys(merged).length;
  // Same as `runAdd`: the merge landed, and a finding still fails the run.
  const findings = [...indexFindings, ...app.findings];
  return {
    ok: findings.length === 0,
    command: 'i18n',
    summary: msg('cli.i18n.synced', { locale, from: from ?? locale, added: added.length, total }),
    // The keys themselves, raw — `runCheck` lists gaps the same way, because a key is a value an
    // author copies and never prose the catalog owns. Every added key is one a human still owes.
    lines: added.map((key) => `  ${key}`),
    findings,
    data: {
      locale,
      from: from ?? locale,
      added,
      total,
      path: catalogLocation(layout, locale),
      registered,
      // Which of `added` still need a human: every one but an admin label in the default locale.
      // `⟦key⟧` where there was no catalog to copy from, `⟦<default string>⟧` on a real merge —
      // both are what `x i18n check` counts as missing until replaced, so `--json` never reports a
      // copy as a translation.
      placeholders: added.filter((key) => isLoudMiss(merged[key])),
      // The admin keys also written to the default locale's catalog, so every app catalog keeps one
      // key set (`backfillDefault`). Empty when the default locale is the one synced.
      defaultAdded,
    },
  };
}

export const i18nCommand: CliCommand = {
  spec: i18nSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('i18n', ctx.cwd).dir;
    const sub = ctx.args.subcommand ?? 'check';
    if (sub === 'add') return runAdd(root, ctx);
    if (sub === 'sync') return runSync(root, ctx);
    if (sub === 'split') {
      const named = ctx.args.positionals[0] === undefined ? undefined : resolveOneLocale(ctx, sub);
      return runSplit(root, named);
    }
    return runCheck(root);
  },
};
