// Pure facts behind `x i18n`: the source scan, the catalogs on disk, the audit, and the seed/sync
// key sets. No CLI shapes and no msg() — an app root in, plain data out, so every path here is
// testable without a ParsedArgs or a rendered message.

// `node:` and not Bun: Bun exposes no existence check (`existsSync`, which is how a missing
// `catalogs/` directory reads as "nothing shipped" instead of a throw) and no path API at all —
// `join` builds the absolute path `Bun.file` reads, and `relative`/`sep` turn it back into the
// root-relative POSIX shape every CLI-reported path is keyed by.
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { renderThrowable } from '@ultimat3/core';
import type { Catalog, Extraction, ExtractReport, Locale } from '@ultimat3/i18n';
import {
  auditCatalogs,
  catalogInvalid,
  catalogKeys,
  DEFAULT_LOCALE,
  extractFromFiles,
  loadCatalog,
  missingFrom,
  nestCatalog,
} from '@ultimat3/i18n';
import { eachSourceFile, isTest } from './source-files';
import { CATALOG_ROOT, catalogPath } from './templates/locales';

/**
 * Every `t()` call the app's own source makes. `source-files.ts` (`eachSourceFile`) is the one
 * glob set every text-scanning gate step already shares (`errors`, `filesize`) — a second glob
 * here would mean this command and `x verify` disagree on what "the app's source" is. Test files
 * are excluded: a fixture's `t('fixture.key')` is not a gap the shipped catalogs owe an answer to.
 * `extractFromFiles` reads by absolute path, so its `file` label is rewritten back to the same
 * root-relative POSIX shape `app-load.ts` uses for every other CLI-reported path.
 */
export async function scanSource(root: string): Promise<Extraction> {
  const files: string[] = [];
  for await (const file of eachSourceFile(root)) {
    if (!isTest(file)) files.push(file);
  }
  const extraction = await extractFromFiles(files.map((file) => join(root, file)));
  const toRelative = (file: string): string => relative(root, file).split(sep).join('/');
  return {
    usages: extraction.usages.map((usage) => ({ ...usage, file: toRelative(usage.file) })),
    dynamic: extraction.dynamic.map((entry) => ({ ...entry, file: toRelative(entry.file) })),
  };
}

/**
 * A `JSON.parse` failure is still a catalog problem, not a bare-Error crash through this command —
 * reported through the same factory a structural violation (`loadCatalog` below) uses.
 */
function parseCatalogJson(path: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw catalogInvalid(path, renderThrowable(error));
  }
}

/**
 * Every `packages/i18n/catalogs/*.json` on disk, parsed and flattened through `loadCatalog` —
 * never a bare `JSON.parse`: a nested `{ one, other }` plural authored by hand is a known past
 * bug, and `loadCatalog` is the seam that fails it loud (`X_CATALOG_INVALID`) instead of auditing
 * it as an empty catalog. No `catalogs/` directory yet (a fresh app, or `packages/i18n` never
 * scaffolded) yields `{}` — every caller here treats that as "nothing shipped", not an error.
 */
export async function loadCatalogs(root: string): Promise<Readonly<Record<Locale, Catalog>>> {
  const dir = join(root, CATALOG_ROOT);
  if (!existsSync(dir)) return {};
  const catalogs: Record<string, Catalog> = {};
  for await (const entry of new Bun.Glob('*.json').scan({ cwd: dir, absolute: false })) {
    const locale = entry.replace(/\.json$/, '');
    const path = catalogPath(locale);
    const raw = await Bun.file(join(root, path)).text();
    catalogs[locale] = loadCatalog(parseCatalogJson(path, raw));
  }
  return catalogs;
}

export interface AuditFacts {
  readonly report: ExtractReport;
  readonly catalogs: Readonly<Record<Locale, Catalog>>;
}

/** The static head of a template literal, up to its first interpolation. */
const TEMPLATE_HEAD = /^`([^`$]*)\$\{/;

/**
 * `unused` is the half of the audit an agent acts on destructively — it reads as "safe to delete".
 * A key only ever reached through `t(`plans.${plan}.name`)` is used, and reporting it unused is
 * how a live key gets deleted. `AuditInput.ignoreUnused` exists for exactly this, so every dynamic
 * call contributes its own static head as a `prefix*` pattern. An expression that is not a template
 * literal (a ternary over string literals, a bare variable) contributes nothing: guessing a prefix
 * from it would suppress real findings, and the `dynamic` list already names it for a human.
 */
export function runtimeKeyPatterns(extraction: Extraction): readonly string[] {
  const patterns = new Set<string>();
  for (const entry of extraction.dynamic) {
    const head = TEMPLATE_HEAD.exec(entry.expression)?.[1];
    if (head !== undefined && head.length > 0) patterns.add(`${head}*`);
  }
  return [...patterns].sort();
}

/** The source scan and the catalogs on disk, audited together — the one fact `x i18n check` reports. */
export async function auditApp(root: string): Promise<AuditFacts> {
  const [extraction, catalogs] = await Promise.all([scanSource(root), loadCatalogs(root)]);
  const ignoreUnused = runtimeKeyPatterns(extraction);
  return { report: auditCatalogs({ extraction, catalogs, ignoreUnused }), catalogs };
}

/**
 * Which locale is the source of truth for seeding (`x i18n add`) and syncing (`x i18n sync`).
 * `declared` is the app's own `defineCatalogs({ default })`, projected by `app-load.ts` from
 * `@ultimat3/i18n`'s `localeConfig()` — the framework's answer to its own question, never a parse
 * of the app's source. Three rules, in order:
 *  1. `declared`, trusted only when a catalog for it actually exists on disk.
 *  2. `en`, when a catalog for it exists — every app `x new` scaffolds has one, so this covers
 *     every real app even when the i18n module would not import.
 *  3. The sole catalog on disk, when there is exactly one.
 * `undefined` when none of the three resolve (no catalogs yet, or several with no `en` and nothing
 * on disk answering `declared`) — callers seed/sync from an empty source rather than guess at one.
 */
export function resolveDefaultLocale(
  declared: string | undefined,
  catalogs: Readonly<Record<Locale, Catalog>>,
): Locale | undefined {
  if (declared !== undefined && Object.hasOwn(catalogs, declared)) return declared;
  if (Object.hasOwn(catalogs, DEFAULT_LOCALE)) return DEFAULT_LOCALE;
  const locales = Object.keys(catalogs);
  return locales.length === 1 ? locales[0] : undefined;
}

/**
 * A sorted copy of `catalog`. Every write below goes through this, so a later `sync` (or a second
 * `add`) diffs only the keys that actually changed, never a reshuffle.
 */
function sortCatalog(catalog: Catalog): Catalog {
  const out: Record<string, string> = {};
  for (const key of catalogKeys(catalog)) {
    const value = catalog[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * `x i18n add`'s seed: every key the default locale defines, values copied verbatim — an
 * untranslated string that renders is strictly better than a missing key that renders `⟦key⟧`.
 */
export function seedCatalog(source: Catalog): Catalog {
  return sortCatalog(source);
}

export interface SyncResult {
  readonly merged: Catalog;
  readonly added: readonly string[];
}

/**
 * `x i18n sync`: every key `source` has that `target` does not, added; every key `target` already
 * has stays exactly as written, translated or not.
 */
export function syncCatalog(target: Catalog, source: Catalog): SyncResult {
  const added = missingFrom(source, target);
  if (added.length === 0) return { merged: target, added };
  const merged: Record<string, string> = { ...target };
  for (const key of added) {
    const value = source[key];
    if (value !== undefined) merged[key] = value;
  }
  return { merged: sortCatalog(merged), added };
}

/**
 * `Bun.write`'s contents for any catalog this command writes: **nested**, sorted, 2-space indent,
 * a trailing newline — the shape a hand-authored catalog already has, so the next `sync` or edit
 * produces a clean diff. Nested is load-bearing, not cosmetic: `Catalog` is the flat dot-key form
 * the translator reads, and a file written in it is one `loadCatalog` refuses on the very next
 * read (`X_CATALOG_INVALID` — a dot is not a key segment). `nestCatalog` is `@ultimat3/i18n`'s own
 * inverse of the flatten every read does, so a catalog this command writes round-trips through it.
 */
export function serializeCatalog(catalog: Catalog): string {
  return `${JSON.stringify(nestCatalog(sortCatalog(catalog)), null, 2)}\n`;
}
