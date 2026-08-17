#!/usr/bin/env bun
// Enforce, as a gate step, that `packages/i18n/src/catalogs/en.json` still describes the framework
// packages' own strings. Both directions, because both had already drifted: a `t('admin.list.…')`
// with no entry renders `⟦admin.list.loading⟧` on a shipped screen, and an `admin.nav.dashboard`
// nothing renders describes an admin UI that no longer exists and reads to the next author as a
// key that works. Runs on `x verify`'s `boundaries` step, through the host-check seam the tier
// table and the admin flattener already use.
//
// THE MECHANISM IS `@ultimat3/i18n`'s. `extractFromFiles` + `auditCatalogs` are what `x i18n check`
// runs for an APP; nothing pointed them at the framework's own catalog, because this repo is not an
// app (no `x.config.ts`, and its catalog is `src/catalogs/en.json`, not the app layout's
// `packages/i18n/catalogs/`). This file supplies the inputs and one policy `auditCatalogs` cannot
// hold: which namespaces the unused half applies to.
//
//   bun run scripts/i18n-catalog.ts [--json]

import type { Catalog, Extraction, KeyUsage } from '@ultimat3/i18n';
import { auditCatalogs, loadCatalog } from '@ultimat3/i18n';
import { parseScriptArgs } from './lib/args';
import { scanFrameworkCatalogSources } from './lib/i18n-scan';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

export const CATALOG_FILE = 'packages/i18n/src/catalogs/en.json';

/**
 * `missing` is the hazard: a key the source renders and the catalog does not answer. `unused` is
 * the other direction — a catalog key nothing can reach — and it is scoped, see `coveredNamespaces`.
 */
export type CatalogGapKind = 'missing' | 'unused';

export interface CatalogGap {
  readonly kind: CatalogGapKind;
  readonly key: string;
  /** `file:line` of the first call site for `missing`; the catalog for `unused`. */
  readonly at: string;
}

export interface CatalogInput {
  /** The flattened `en.json`. */
  readonly catalog: Catalog;
  /** `t()` call sites, static and dynamic, as `@ultimat3/i18n` extracted them. */
  readonly extraction: Extraction;
  /**
   * Every key-shaped string literal in the scanned source, `t()` argument or not. Over-approximates
   * reachability ON PURPOSE: a key carried as data (`titleKey: 'admin.dashboard.title'`, an audit
   * `reason`) is reached through a `t(variable)` no scan can follow, and under-approximating here
   * would report a live key as deletable — the one way this check could do damage.
   */
  readonly literals: readonly string[];
}

/**
 * The static head of a template literal, up to its first interpolation — `t(`admin.operation.${op}`)`
 * contributes `admin.operation.*`. Twin of `runtimeKeyPatterns` in `packages/cli/src/i18n-audit.ts`,
 * which does the same for an app; it is not exported from `@ultimat3/cli`, so the eight lines live
 * here rather than widening that package's public API for one caller.
 */
const TEMPLATE_HEAD = /^`([^`$]*)\$\{/;

function runtimePrefixes(extraction: Extraction): readonly string[] {
  const patterns = new Set<string>();
  for (const entry of extraction.dynamic) {
    const head = TEMPLATE_HEAD.exec(entry.expression)?.[1];
    if (head !== undefined && head.length > 0) patterns.add(`${head}*`);
  }
  return [...patterns].sort();
}

const namespaceOf = (key: string): string => key.split('.')[0] ?? key;

/**
 * A namespace the unused half applies to: one where the framework already reaches at least one key.
 * Derived, never listed, because the alternative is a policy table that rots. `admin.*` and `dev.*`
 * are covered because framework source names keys in them; `auth.*`, `common.*`, `validation.*`,
 * `pagination.*` and `errors.*` are the string API this catalog OFFERS an app — nothing here renders
 * them, and "unused by the framework" is not a defect for a namespace the framework only ships.
 */
export function coveredNamespaces(
  catalog: Catalog,
  reachable: (key: string) => boolean,
): ReadonlySet<string> {
  const covered = new Set<string>();
  for (const key of Object.keys(catalog)) {
    if (reachable(key)) covered.add(namespaceOf(key));
  }
  return covered;
}

const firstUsage = (usages: readonly KeyUsage[], key: string): string => {
  const usage = usages.find((one) => one.key === key);
  return usage === undefined ? CATALOG_FILE : `${usage.file}:${usage.line}`;
};

const byKey = (a: CatalogGap, b: CatalogGap): number =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

/**
 * Pure, so the negative case is a fixture rather than an edit to the real catalog. Takes the three
 * inputs whole: the catalog, the extraction and the literal set.
 */
export function checkCatalog(input: CatalogInput): readonly CatalogGap[] {
  const prefixes = runtimePrefixes(input.extraction);
  const literals = new Set(input.literals);
  const ignoreUnused = [...literals, ...prefixes];

  // One `auditCatalogs` call does both halves; `ignoreUnused` is where the literal set lands,
  // because that is exactly the parameter the package grew for keys resolved at runtime.
  const audit = auditCatalogs({
    extraction: input.extraction,
    catalogs: { en: input.catalog },
    ignoreUnused,
  });
  const locale = audit.locales[0];
  if (locale === undefined) return [];

  const reachable = (key: string): boolean => !locale.unused.includes(key);
  const covered = coveredNamespaces(input.catalog, reachable);

  return [
    ...locale.missing.map(
      (key): CatalogGap => ({
        kind: 'missing',
        key,
        at: firstUsage(input.extraction.usages, key),
      }),
    ),
    ...locale.unused
      .filter((key) => covered.has(namespaceOf(key)))
      .map((key): CatalogGap => ({ kind: 'unused', key, at: CATALOG_FILE })),
  ].sort(byKey);
}

const missingFinding = (gap: CatalogGap): Finding => ({
  // `@ultimat3/i18n`'s own code for this condition — the gate reports what the runtime would throw,
  // never a second name for one fact.
  code: 'X_CATALOG_MISSING_KEYS',
  cause: `${gap.at} renders t('${gap.key}') and ${CATALOG_FILE} has no such key, so the screen shows the literal ⟦${gap.key}⟧`,
  fix: `add "${gap.key}" to ${CATALOG_FILE}, nested — "${gap.key.split('.').join('" › "')}"`,
  at: gap.at,
});

const unusedFinding = (gap: CatalogGap): Finding => ({
  code: 'X_CATALOG_KEY_UNREACHABLE',
  cause: `${CATALOG_FILE} defines "${gap.key}" and no framework source names it, so it describes a screen that no longer exists`,
  fix: `delete "${gap.key}" from ${CATALOG_FILE}, or render it — t('${gap.key}') in the view that needs it`,
  at: CATALOG_FILE,
});

const FINDINGS: Readonly<Record<CatalogGapKind, (gap: CatalogGap) => Finding>> = {
  missing: missingFinding,
  unused: unusedFinding,
};

export const catalogGapFindingFor = (gap: CatalogGap): Finding => FINDINGS[gap.kind](gap);

/**
 * Read the catalog and the sources, then check them. The one impure step.
 *
 * A root with no catalog is not this check's problem: `tierBoundaries` runs against a synthetic
 * tree in `scripts/verify.test.ts`, and a rule that threw there would make the tier test depend on
 * a file it is not about. The catalog going missing for real is a TYPECHECK failure, not a silent
 * pass — `packages/i18n/src/framework.ts` imports `./catalogs/en.json` statically.
 */
export async function frameworkCatalogGaps(root: string): Promise<readonly CatalogGap[]> {
  const file = Bun.file(`${root}/${CATALOG_FILE}`);
  if (!(await file.exists())) return [];
  const raw: unknown = await file.json();
  const scan = await scanFrameworkCatalogSources(root);
  return checkCatalog({ catalog: loadCatalog(raw), ...scan });
}

/** What this repo contributes to `x verify`'s `boundaries` step. */
export const frameworkCatalogFindings = async (root: string): Promise<readonly Finding[]> =>
  (await frameworkCatalogGaps(root)).map(catalogGapFindingFor);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const raw: unknown = await Bun.file(`${root}/${CATALOG_FILE}`).json();
  const catalog = loadCatalog(raw);
  const gaps = await frameworkCatalogGaps(root);
  report(
    {
      ok: gaps.length === 0,
      script: 'i18n-catalog',
      summary:
        gaps.length === 0
          ? `${Object.keys(catalog).length} keys in ${CATALOG_FILE}, every one reachable and every rendered key answered`
          : `${gaps.length} catalog gap(s) in ${CATALOG_FILE}`,
      findings: gaps.map(catalogGapFindingFor),
    },
    args.json,
  );
}
