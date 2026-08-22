// `x i18n check|add <locale>|sync <locale>` — the command every X_LOCALE_UNSUPPORTED,
// X_CATALOG_MISSING_KEYS and X_CATALOG_INVALID fix line already names. CLI wiring only: the
// facts come from `i18n-audit.ts`, the audit itself from `@ultimat3/i18n`'s own `auditCatalogs`.

// `node:` and not Bun: Bun has no exclusive-create write, and `open(path, 'wx')` is the only one
// there is — `Bun.write` overwrites, so an existence check before it is a race a second `x i18n
// add` wins. `mkdir` comes with it because `open` does not create the parent directory `Bun.write`
// would, and `node:path` because Bun exposes no path API to build what either of them takes.
import { type FileHandle, mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Catalog } from '@ultimat3/i18n';
import { auditCatalogs, catalogKeys } from '@ultimat3/i18n';
import { loadApp } from './app-load';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, CatalogExistsError, MissingPositionalError } from './errors';
import {
  auditApp,
  loadCatalogs,
  resolveDefaultLocale,
  scanSource,
  seedCatalog,
  serializeCatalog,
  syncCatalog,
} from './i18n-audit';
import {
  checkRegistration,
  loudMiss,
  missingKeyFindings,
  withPlaceholdersMissing,
} from './i18n-registration';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { renderTable } from './table';
import { catalogPath, resolveLocales } from './templates/locales';

export const I18N_SUBCOMMANDS = ['check', 'add', 'sync'] as const;

/** `ExtractReport` is plain JSON by construction — same idiom as `cmd-registries.ts`'s `asJson`. */
const asJson = (value: object): Record<string, JsonValue> => value as Record<string, JsonValue>;

/** `open`'s failure when the file is already there — the one errno this command translates. */
const isAlreadyExists = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';

/**
 * The exclusive half of the create: `wx` fails rather than truncates, so an existing catalog is
 * refused by the write itself. An `existsSync` before a `Bun.write` is the same answer with a
 * window in it, and what falls through that window is a translator's work.
 */
async function openExclusive(absolute: string, locale: string): Promise<FileHandle> {
  try {
    return await open(absolute, 'wx');
  } catch (error) {
    if (isAlreadyExists(error)) throw new CatalogExistsError({ locale, path: catalogPath(locale) });
    throw error;
  }
}

/** `x i18n add`'s only write. `catalogs/` may not exist yet, and `open` never creates it. */
async function writeNewCatalog(absolute: string, locale: string, contents: string): Promise<void> {
  await mkdir(dirname(absolute), { recursive: true });
  const handle = await openExclusive(absolute, locale);
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
}

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
    fix: `x i18n ${sub} es`,
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

async function runCheck(root: string): Promise<CommandResult> {
  const { report: audited, catalogs, extraction, ignoreUnused } = await auditApp(root);
  // Corrected once, before anything reads it: the table's `missing` column, the summary count, the
  // findings and `--json`'s `data` are four projections of one report, and a placeholder counted in
  // only some of them is the command disagreeing with itself about the same app.
  const report = withPlaceholdersMissing(audited, catalogs);
  // The runtime question, asked after the file question and never instead of it: a catalog can be
  // complete on disk, used everywhere in source, and reach no registry at all (issue #249).
  const registration = await checkRegistration({ root, catalogs, extraction, ignoreUnused });

  const findings: Finding[] = [...missingKeyFindings(report), ...registration.findings];

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
  // catalog entry and an entry no registry holds are the same `⟦key⟧` on the same page.
  const gapLocales =
    report.locales.filter((audit) => audit.missing.length > 0).length + registration.locales;
  const missingTotal =
    report.locales.reduce((sum, audit) => sum + audit.missing.length, 0) +
    registration.unregistered;
  const ok = report.ok && registration.ok;
  const summary = ok
    ? msg('cli.i18n.ok', { locales: report.locales.length, keys: report.used.length })
    : msg('cli.i18n.gaps', { missing: missingTotal, locales: gapLocales });

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
  const path = catalogPath(locale);
  const app = await loadApp(root);
  const catalogs = await loadCatalogs(root);
  const from = resolveDefaultLocale(app.defaultLocale, catalogs);
  const seeded = seedCatalog(from === undefined ? {} : (catalogs[from] ?? {}));
  await writeNewCatalog(join(root, path), locale, serializeCatalog(seeded));

  const keys = catalogKeys(seeded).length;
  return {
    // The catalog is on disk, so the command did what it was asked. `loadApp`'s findings ride along
    // rather than flip that: a `packages/i18n/src/index.ts` that would not import is why `from` may
    // be the framework's `en` instead of the app's own default, and silence there is the bug.
    ok: true,
    command: 'i18n',
    summary: msg('cli.i18n.added', { locale, keys, from: from ?? locale }),
    findings: app.findings,
    data: { locale, from: from ?? locale, keys, path },
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
  const report = withPlaceholdersMissing(auditCatalogs({ extraction, catalogs }), catalogs);
  return report.locales.find((audit) => audit.locale === locale)?.missing ?? [];
}

const placeholderCatalog = (keys: readonly string[]): Catalog =>
  Object.fromEntries(keys.map((key) => [key, loudMiss(key)]));

async function runSync(root: string, ctx: CommandContext): Promise<CommandResult> {
  const locale = resolveOneLocale(ctx, 'sync');
  const catalogs = await loadCatalogs(root);
  const target = catalogs[locale];
  if (target === undefined) {
    throw new BadFlagError({
      flag: 'locale',
      command: 'i18n',
      reason: `no catalog for "${locale}" at ${catalogPath(locale)}`,
      fix: `x i18n add ${locale}`,
    });
  }

  const app = await loadApp(root);
  const from = resolveDefaultLocale(app.defaultLocale, catalogs);
  // `from === locale` is the default locale asked to sync itself, and `undefined` is an app with
  // no resolvable default at all — one branch, because both have no catalog to merge from.
  const seeded = from === undefined || from === locale;
  const source = seeded
    ? placeholderCatalog(await untranslatedKeys(root, catalogs, locale))
    : (catalogs[from] ?? {});
  const { merged, added } = syncCatalog(target, source);
  if (added.length > 0) await Bun.write(join(root, catalogPath(locale)), serializeCatalog(merged));

  const total = catalogKeys(merged).length;
  return {
    // Same as `runAdd`: the merge landed, and `loadApp`'s findings say whether `from` is the app's
    // own default or the framework's fallback standing in for an i18n module that would not import.
    ok: true,
    command: 'i18n',
    summary: msg('cli.i18n.synced', { locale, from: from ?? locale, added: added.length, total }),
    // The keys themselves, raw — `runCheck` lists gaps the same way, because a key is a value an
    // author copies and never prose the catalog owns.
    lines: seeded ? added.map((key) => `  ${key}`) : [],
    findings: app.findings,
    data: {
      locale,
      from: from ?? locale,
      added,
      total,
      path: catalogPath(locale),
      // Which of `added` still need a human. Empty on a real merge, where every value is a real
      // string copied from the default locale — `--json` must be able to tell the two apart.
      placeholders: seeded ? added : [],
    },
  };
}

export const i18nCommand: CliCommand = {
  spec: {
    name: 'i18n',
    summary: 'catalogs: add a locale, sync keys, check for gaps',
    usage: 'x i18n [check|add <locale>|sync <locale>] [--json]',
    requiresApp: true,
    subcommands: I18N_SUBCOMMANDS,
    // The bare `x i18n` audits; `add` and `sync` write catalogs and must be asked for.
    defaultSubcommand: 'check',
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('i18n', ctx.cwd).dir;
    const sub = ctx.args.subcommand ?? 'check';
    if (sub === 'add') return runAdd(root, ctx);
    if (sub === 'sync') return runSync(root, ctx);
    return runCheck(root);
  },
};
