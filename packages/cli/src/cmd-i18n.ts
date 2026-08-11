// `x i18n check|add <locale>|sync <locale>` — the command every X_LOCALE_UNSUPPORTED,
// X_CATALOG_MISSING_KEYS and X_CATALOG_INVALID fix line already names. CLI wiring only: the
// facts come from `i18n-audit.ts`, the audit itself from `@ultimat3/i18n`'s own `auditCatalogs`.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { catalogKeys, catalogMissingKeys } from '@ultimat3/i18n';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, docsFor } from './errors';
import {
  auditApp,
  loadCatalogs,
  resolveDefaultLocale,
  seedCatalog,
  serializeCatalog,
  syncCatalog,
} from './i18n-audit';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { findingFrom } from './output';
import { renderTable } from './table';
import { catalogPath, resolveLocales } from './templates/locales';

export const I18N_SUBCOMMANDS = ['check', 'add', 'sync'] as const;

/** `ExtractReport` is plain JSON by construction — same idiom as `cmd-registries.ts`'s `asJson`. */
const asJson = (value: object): Record<string, JsonValue> => value as Record<string, JsonValue>;

/**
 * `x i18n add` refuses to clobber a catalog that already exists — a human translation lost to a
 * second run is unrecoverable. `X_GENERATE_CONFLICT` is already owned by this package
 * (`packages/cli/src/errors.ts`) and used today only as a `Finding` literal inside
 * `cmd-generate.ts`'s `writeFiles`, never thrown; this constructs the same registered code as a
 * real `UltimateError` instead of adding a second class to a file this piece does not own.
 */
class CatalogExistsError extends UltimateError {
  constructor(locale: string) {
    super({
      code: 'X_GENERATE_CONFLICT',
      cause: `${catalogPath(locale)} already exists`,
      fix: `x i18n sync ${locale}`,
      docs: docsFor('X_GENERATE_CONFLICT'),
    });
  }
}

function requireLocalePositional(ctx: CommandContext, sub: string): string {
  const raw = ctx.args.positionals[0];
  if (raw === undefined) {
    throw new BadFlagError({
      flag: 'locale',
      command: 'i18n',
      reason: `"x i18n ${sub}" needs a locale: x i18n ${sub} <locale>`,
    });
  }
  return raw;
}

/**
 * Validates + canonicalizes the positional locale — `resolveLocales`'s own BCP-47/escape checks
 * do the refusing, with a fix that names this command (`x i18n add es` / `x i18n sync es`)
 * instead of the generic `x g` default.
 */
function resolveOneLocale(ctx: CommandContext, sub: string): string {
  const raw = requireLocalePositional(ctx, sub);
  const resolved = resolveLocales([raw], `x i18n ${sub} es`);
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
  const { report, catalogs } = await auditApp(root);

  const findings: Finding[] = report.locales
    .filter((audit) => audit.missing.length > 0)
    .map((audit) => ({
      ...findingFrom(catalogMissingKeys(audit.locale, audit.missing)),
      at: catalogPath(audit.locale),
    }));

  const header = ['locale', 'keys', 'missing', 'unused'];
  const rows = report.locales.map((audit) => [
    audit.locale,
    String(catalogKeys(catalogs[audit.locale] ?? {}).length),
    String(audit.missing.length),
    String(audit.unused.length),
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

  const gapLocales = report.locales.filter((audit) => audit.missing.length > 0).length;
  const missingTotal = report.locales.reduce((sum, audit) => sum + audit.missing.length, 0);
  const summary = report.ok
    ? msg('cli.i18n.ok', { locales: report.locales.length, keys: report.used.length })
    : msg('cli.i18n.gaps', { missing: missingTotal, locales: gapLocales });

  return { ok: report.ok, command: 'i18n', summary, lines, findings, data: asJson(report) };
}

async function runAdd(root: string, ctx: CommandContext): Promise<CommandResult> {
  const locale = resolveOneLocale(ctx, 'add');
  const path = catalogPath(locale);
  if (existsSync(join(root, path))) throw new CatalogExistsError(locale);

  const catalogs = await loadCatalogs(root);
  const from = await resolveDefaultLocale(root, catalogs);
  const seeded = seedCatalog(from === undefined ? {} : (catalogs[from] ?? {}));
  await Bun.write(join(root, path), serializeCatalog(seeded));

  const keys = catalogKeys(seeded).length;
  return {
    ok: true,
    command: 'i18n',
    summary: msg('cli.i18n.added', { locale, keys, from: from ?? locale }),
    data: { locale, from: from ?? locale, keys, path },
  };
}

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

  const from = await resolveDefaultLocale(root, catalogs);
  const source = from === undefined ? {} : (catalogs[from] ?? {});
  const { merged, added } = syncCatalog(target, source);
  if (added.length > 0) await Bun.write(join(root, catalogPath(locale)), serializeCatalog(merged));

  const total = catalogKeys(merged).length;
  return {
    ok: true,
    command: 'i18n',
    summary: msg('cli.i18n.synced', { locale, from: from ?? locale, added: added.length, total }),
    data: { locale, from: from ?? locale, added, total, path: catalogPath(locale) },
  };
}

export const i18nCommand: CliCommand = {
  spec: {
    name: 'i18n',
    summary: 'catalogs: add a locale, sync keys, check for gaps',
    usage: 'x i18n [check|add <locale>|sync <locale>] [--json]',
    requiresApp: true,
    subcommands: I18N_SUBCOMMANDS,
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('i18n', ctx.cwd).dir;
    const sub = ctx.args.subcommand ?? 'check';
    if (sub === 'add') return runAdd(root, ctx);
    if (sub === 'sync') return runSync(root, ctx);
    return runCheck(root);
  },
};
