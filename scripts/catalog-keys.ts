#!/usr/bin/env bun
// Enforce, as a gate rule, that every i18n key the framework hands to `t()` as DATA — in a constant
// or a property, `reason: ROW_CHANGED_REASON` — resolves in a catalog the framework ships. The
// reverse of `i18n-catalog.ts`'s unreachable-key half; a missing one renders `⟦admin.error.…⟧`.
//   bun run catalog-keys  ·  bun run scripts/catalog-keys.ts [--json]

import type { Catalog } from '@ultimat3/i18n';
import { loadCatalog } from '@ultimat3/i18n';
import { MAIL_CATALOG } from '../packages/mail/src/catalog';
import { CATALOG_FILE } from './i18n-catalog';
import { parseScriptArgs } from './lib/args';
import { corpus } from './lib/corpus';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { lineOf } from './lib/source-scan';

const SCRIPT = 'catalog-keys';
const TEMPLATE_DIR = 'packages/cli/src/templates/';
const MAIL_CATALOG_FILE = 'packages/mail/src/catalog.ts';

/** `t(x)`, `ui.t(x)`, `i18n.t(x)` with a dotted-identifier argument; `.at(` is not `t(`. */
const DYNAMIC_CALL =
  /(?<![\w$.])(?:[A-Za-z_$][\w$]*\.)?t\(\s*([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\s*[,)]/g;
const TABLE_NAME = /^[A-Z][A-Z0-9_]*$/;
/** The one name too generic to carry provenance — see the header. */
const NOT_A_CARRIER: ReadonlySet<string> = new Set(['key']);
/** The key shape `i18n-scan.ts` reads: lower-case head, at least two dot-separated segments. */
const KEY = String.raw`(?<q>['"])(?<lit>[a-z][\w-]*(?:\.[\w-]+)+)\k<q>`;

export interface Carriers {
  /** Property and variable names whose VALUE is handed to `t()`. */
  readonly names: ReadonlySet<string>;
  /** `SCREAMING` objects whose members are handed to `t()`. */
  readonly tables: ReadonlySet<string>;
}

export interface CarriedKey {
  readonly path: string;
  readonly line: number;
  readonly key: string;
  /** How the scan reached it: `reason:`, `const ROW_CHANGED_REASON`, `UI_KEYS.close`. */
  readonly via: string;
}

export interface SourceText {
  readonly path: string;
  /** Comments blanked, strings kept — `CorpusFile.stripped`. */
  readonly text: string;
}

/**
 * Every carrier the sources name, read off their dynamic `t()` calls. PROVENANCE, NOT SHAPE: a
 * carrier is a name some framework source actually passes to `t()` — the last segment of
 * `t(row.reason)` makes `reason` one, `t(UNSUBSCRIBE_KEY)` makes that constant one,
 * `ui.t(UI_KEYS.close)` makes `UI_KEYS` a key table. Derived on every run, never listed. `key`
 * alone is not one: it is also every config path and cache key in the tree, and reading it as a
 * carrier reported six config paths (`key: 'realtime.transport'`) and no i18n key.
 */
export function deriveCarriers(files: readonly SourceText[]): Carriers {
  const names = new Set<string>();
  const tables = new Set<string>();
  for (const file of files) {
    for (const match of file.text.matchAll(DYNAMIC_CALL)) {
      const chain = (match[1] ?? '').split(/\??\./);
      const head = chain[0] ?? '';
      const last = chain.at(-1) ?? '';
      if (chain.length > 1 && TABLE_NAME.test(head)) tables.add(head);
      else if (!NOT_A_CARRIER.has(last)) names.add(last);
    }
  }
  return { names, tables };
}

/** A property position: the previous non-blank character opens or continues an object literal. */
const inObject = (text: string, index: number): boolean => {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(text[cursor] ?? '')) cursor -= 1;
  return cursor < 0 || text[cursor] === '{' || text[cursor] === ',';
};

/** The `{…}` body opened at `open`, braces in strings ignored — a table body is flat data. */
const bodyAt = (text: string, open: number): string => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}' && --depth === 0) return text.slice(open, index);
  }
  return '';
};

/** Every key-shaped literal a carrier holds in one file. */
export function carriedKeys(file: SourceText, carriers: Carriers): readonly CarriedKey[] {
  const out: CarriedKey[] = [];
  const push = (index: number, key: string, via: string): void => {
    out.push({ path: file.path, line: lineOf(file.text, index), key, via });
  };
  const property = new RegExp(String.raw`(?<![\w$.])(?<name>[A-Za-z_$][\w$]*)\s*:\s*${KEY}`, 'g');
  for (const match of file.text.matchAll(property)) {
    const name = match.groups?.['name'] ?? '';
    if (carriers.names.has(name) && inObject(file.text, match.index)) {
      push(match.index, match.groups?.['lit'] ?? '', `${name}:`);
    }
  }
  const constant = new RegExp(
    String.raw`\b(?:const|let)\s+(?<name>[A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*${KEY}`,
    'g',
  );
  for (const match of file.text.matchAll(constant)) {
    const name = match.groups?.['name'] ?? '';
    if (carriers.names.has(name)) push(match.index, match.groups?.['lit'] ?? '', `const ${name}`);
  }
  const table = /\b(?:const|let)\s+(?<name>[A-Z][A-Z0-9_]*)\s*(?::[^=;\n]+)?=\s*\{/g;
  for (const match of file.text.matchAll(table)) {
    const name = match.groups?.['name'] ?? '';
    if (!carriers.tables.has(name)) continue;
    const open = match.index + match[0].length - 1;
    const member = new RegExp(String.raw`(?<member>[A-Za-z_$][\w$]*)\s*:\s*${KEY}`, 'g');
    for (const entry of bodyAt(file.text, open).matchAll(member)) {
      push(open + entry.index, entry.groups?.['lit'] ?? '', `${name}.${entry.groups?.['member']}`);
    }
  }
  return out;
}

/**
 * Module constants a carrier is ASSIGNED from: `reason: ROW_CHANGED_REASON` makes the constant a
 * carrier too, wherever it is declared — the admin's reason constants live one file away from their
 * use. `SCREAMING` only: a lower-case value (`reason: cause`) is computed at run time, and a type
 * annotation (`reason: string`) is no value at all.
 */
export function assignedNames(files: readonly SourceText[], carriers: Carriers): Carriers {
  const names = new Set(carriers.names);
  const assigned = /(?<![\w$.])(?<name>[A-Za-z_$][\w$]*)\s*:\s*(?<value>[A-Z][A-Z0-9_]*)\s*[,}\n]/g;
  for (const file of files) {
    for (const match of file.text.matchAll(assigned)) {
      if (carriers.names.has(match.groups?.['name'] ?? ''))
        names.add(match.groups?.['value'] ?? '');
    }
  }
  return { names, tables: carriers.tables };
}

export type CatalogKeyGap =
  | { readonly kind: 'missing'; readonly site: CarriedKey }
  | { readonly kind: 'unscanned' };

/** Pure: the carried keys against the catalogs. No carried key at all is a scan that read nothing. */
export function checkCarriedKeys(
  sites: readonly CarriedKey[],
  catalogs: readonly Catalog[],
): readonly CatalogKeyGap[] {
  if (sites.length === 0) return [{ kind: 'unscanned' }];
  return sites
    .filter((site) => !catalogs.some((catalog) => Object.hasOwn(catalog, site.key)))
    .map((site) => ({ kind: 'missing', site }));
}

export function catalogKeyFinding(gap: CatalogKeyGap): Finding {
  if (gap.kind === 'unscanned') {
    return {
      code: 'X_CATALOG_CARRIER_UNSCANNED',
      cause:
        'no framework source hands t() a key through a constant or a property this scan recognises, so the rule checked nothing — a renamed t() or a moved corpus reads exactly like a tree with no carried key',
      fix: 'edit DYNAMIC_CALL in scripts/catalog-keys.ts so it matches how the framework calls t(), then bun run scripts/catalog-keys.ts --json',
      at: 'scripts/catalog-keys.ts',
    };
  }
  const { site } = gap;
  const at = `${site.path}:${String(site.line)}`;
  return {
    // `@ultimat3/i18n`'s own code for a key the source renders and no catalog answers — one fact,
    // one name, whether the key was a literal argument or carried in by `${site.via}`.
    code: 'X_CATALOG_MISSING_KEYS',
    cause: `${at} carries "${site.key}" (${site.via}) to t(), and neither ${CATALOG_FILE} nor ${MAIL_CATALOG_FILE} has it, so the screen shows ⟦${site.key}⟧`,
    fix: `add "${site.key}" to ${CATALOG_FILE}, nested as "${site.key.split('.').join('" › "')}" — or correct the key at ${at}`,
    at,
  };
}

/** The shipped sources this rule reads: the `shipped` scope, minus what the CLI emits for an app. */
export async function catalogSources(root: string): Promise<readonly SourceText[]> {
  return (await corpus(root, 'shipped'))
    .filter((file) => !file.path.startsWith(TEMPLATE_DIR))
    .map((file) => ({ path: file.path, text: file.stripped }));
}

export async function carriedKeySites(root: string): Promise<readonly CarriedKey[]> {
  const files = await catalogSources(root);
  const carriers = assignedNames(files, deriveCarriers(files));
  return files.flatMap((file) => carriedKeys(file, carriers));
}

export async function catalogKeyGaps(root: string): Promise<readonly CatalogKeyGap[]> {
  const raw: unknown = await Bun.file(`${root}/${CATALOG_FILE}`).json();
  return checkCarriedKeys(await carriedKeySites(root), [loadCatalog(raw), MAIL_CATALOG]);
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const gaps = await catalogKeyGaps(repoRoot());
  report(
    {
      ok: gaps.length === 0,
      script: SCRIPT,
      summary:
        gaps.length === 0
          ? 'every key the framework carries to t() resolves in a catalog it ships'
          : `${String(gaps.length)} carried key(s) no framework catalog answers`,
      findings: gaps.map(catalogKeyFinding),
    },
    args.json,
  );
}
