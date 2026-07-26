/**
 * Static extraction: which keys the source calls, which are missing per locale, which
 * are defined and never used. `x verify` fails on a missing key in a shipped locale —
 * a translation gap is a build error, not a ticket.
 */

import { type Catalog, catalogKeys } from './catalog';
import { catalogMissingKeys } from './errors';
import { PLURAL_CATEGORIES } from './interpolate';
import type { Locale } from './locales';

export interface KeyUsage {
  key: string;
  file: string;
  line: number;
  column: number;
}

/** `t(key)` where `key` is a variable — the extractor cannot verify it, so it says so. */
export interface DynamicUsage {
  expression: string;
  file: string;
  line: number;
  column: number;
}

export interface Extraction {
  usages: KeyUsage[];
  dynamic: DynamicUsage[];
}

export interface LocaleAudit {
  locale: Locale;
  missing: string[];
  unused: string[];
}

export interface ExtractReport {
  /** Distinct static keys, sorted. */
  used: string[];
  usages: KeyUsage[];
  dynamic: DynamicUsage[];
  locales: LocaleAudit[];
  ok: boolean;
}

export interface ExtractOptions {
  /** Call names treated as translator calls. */
  callees?: readonly string[];
}

const DEFAULT_CALLEES: readonly string[] = ['t', '$t', 'translate'];
const STRING_LITERAL = /^(['"`])((?:[^\\]|\\.)*?)\1$/s;

/**
 * Scan one source file. Deliberately a lexer-free scan: a translator call is a
 * recognisable shape, and a regex that runs in milliseconds over a whole repo beats a
 * parser that needs a tsconfig to start.
 */
export function extractKeys(
  source: string,
  file = '<memory>',
  options: ExtractOptions = {},
): Extraction {
  const callees = options.callees ?? DEFAULT_CALLEES;
  const pattern = new RegExp(
    // not preceded by an identifier char or `.`, so `ctx.t(` and `format(` don't match
    String.raw`(?<![\w$.])(?:${callees.map(escapeRegExp).join('|')})(?:\.has)?\s*\(\s*([^,)]*)`,
    'g',
  );

  const usages: KeyUsage[] = [];
  const dynamic: DynamicUsage[] = [];

  for (const match of source.matchAll(pattern)) {
    const argument = (match[1] ?? '').trim();
    const index = match.index ?? 0;
    const position = positionOf(source, index);
    if (argument === '') continue;
    const literal = STRING_LITERAL.exec(argument);
    const key = literal?.[2];
    if (key === undefined || key.includes('${')) {
      dynamic.push({ expression: argument, file, ...position });
      continue;
    }
    usages.push({ key, file, ...position });
  }

  return { usages, dynamic };
}

export interface AuditInput {
  extraction: Extraction;
  /** Every locale that ships. A locale absent here is not audited. */
  catalogs: Readonly<Record<Locale, Catalog>>;
  /** Keys resolved at runtime (e.g. `time.cron.*`) — never reported unused. */
  ignoreUnused?: readonly string[];
}

/**
 * A used key counts as present when the locale defines it *or* any of its plural
 * variants: `pl` legitimately defines `items_one`/`items_few`/`items_many` and no bare
 * `items`, and that must not read as a missing key.
 */
export function auditCatalogs(input: AuditInput): ExtractReport {
  const used = [...new Set(input.extraction.usages.map((usage) => usage.key))].sort();
  const ignore = input.ignoreUnused ?? [];

  const locales: LocaleAudit[] = Object.keys(input.catalogs)
    .sort()
    .map((locale) => {
      const catalog = input.catalogs[locale] ?? {};
      const missing = used.filter((key) => !definesKey(catalog, key));
      const usedWithVariants = new Set(used.flatMap(variantsOf));
      const unused = catalogKeys(catalog).filter(
        (key) => !usedWithVariants.has(key) && !isIgnored(key, ignore),
      );
      return { locale, missing, unused };
    });

  return {
    used,
    usages: input.extraction.usages,
    dynamic: input.extraction.dynamic,
    locales,
    ok: locales.every((audit) => audit.missing.length === 0),
  };
}

/** The `x verify` gate. Throws on the first locale with a gap, naming file and keys. */
export function assertCatalogsComplete(report: ExtractReport): void {
  for (const audit of report.locales) {
    if (audit.missing.length > 0) throw catalogMissingKeys(audit.locale, audit.missing);
  }
}

/** Merge per-file extractions before auditing. */
export function mergeExtractions(...extractions: readonly Extraction[]): Extraction {
  return {
    usages: extractions.flatMap((extraction) => extraction.usages),
    dynamic: extractions.flatMap((extraction) => extraction.dynamic),
  };
}

/** Read + scan real files. Bun-only by design; the CLI passes the glob results. */
export async function extractFromFiles(
  paths: readonly string[],
  options: ExtractOptions = {},
): Promise<Extraction> {
  const extractions = await Promise.all(
    paths.map(async (path) => extractKeys(await Bun.file(path).text(), path, options)),
  );
  return mergeExtractions(...extractions);
}

function definesKey(catalog: Catalog, key: string): boolean {
  return variantsOf(key).some((candidate) => Object.hasOwn(catalog, candidate));
}

function variantsOf(key: string): string[] {
  return [key, `${key}_plural`, ...PLURAL_CATEGORIES.map((category) => `${key}_${category}`)];
}

function isIgnored(key: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern,
  );
}

function positionOf(source: string, index: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index; i += 1) {
    if (source[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: index - lineStart + 1 };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
