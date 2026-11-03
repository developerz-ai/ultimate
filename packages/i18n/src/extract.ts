/**
 * Static extraction: which keys the source calls, which are missing per locale, which
 * are defined and never used. `x verify` fails on a missing key in a shipped locale —
 * a translation gap is a build error, not a ticket.
 */

import { stripComments } from '@ultimat3/core';
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
  /** What every locale owes: `used` plus each stem the reference locale defines, sorted. */
  required: string[];
  usages: KeyUsage[];
  dynamic: DynamicUsage[];
  locales: LocaleAudit[];
  ok: boolean;
}

/** A property whose value is a catalog key, for an API that takes keys rather than strings. */
export interface KeyProperty {
  name: string;
  /** Only in a file holding this text: a bare `subject:` means nothing on its own. */
  whenFileContains?: string;
}

export interface ExtractOptions {
  /** Call names treated as translator calls. */
  callees?: readonly string[];
  /** Properties whose literal value is a usage and whose any other value is `dynamic`. */
  properties?: readonly KeyProperty[];
}

const DEFAULT_CALLEES: readonly string[] = ['t', '$t', 'translate'];
// The closing quote may not recur inside: `'a' + 'b'` is two literals, not a key spelled `a' + 'b`.
const STRING_LITERAL = /^(['"`])((?:(?!\1)[^\\]|\\.)*)\1$/s;
// A value runs to the first comma, closer or line break outside a string. Strings are matched whole
// so a comma in one does not end it. The trailing `;` is captured because it marks a type member
// (`titleKey: string;`): an object literal never ends a property with one.
const PROPERTY_VALUE = String.raw`((?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\`(?:[^\`\\]|\\.)*\`|[^,;})\n'"\`])*)(;?)`;

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
  const record = (rawArgument: string | undefined, index: number): void => {
    const argument = (rawArgument ?? '').trim();
    const position = positionOf(source, index);
    if (argument === '') return;
    const literal = STRING_LITERAL.exec(argument);
    const key = literal?.[2];
    if (key === undefined || key.includes('${')) {
      dynamic.push({ expression: argument, file, ...position });
      return;
    }
    usages.push({ key, file, ...position });
  };

  // Over the COMMENT-STRIPPED text, never the raw file: a `// … t('…', { … })` in a comment matched
  // the shape above and produced a phantom key that `x i18n sync` would have written into every
  // catalog as `"…": "⟦…⟧"` (measured 2026-09-05). The mask keeps every newline and every string
  // literal in place, so an index into it is an index into `source` and the positions below hold.
  const stripped = stripComments(source);
  for (const match of stripped.matchAll(pattern)) record(match[1], match.index ?? 0);

  for (const property of options.properties ?? []) {
    const marker = property.whenFileContains;
    if (marker !== undefined && !stripped.includes(marker)) continue;
    const name = escapeRegExp(property.name);
    // Not after an identifier char, a `.` or a quote: `subtitleKey`, `a.titleKey`, `'x.titleKey'`.
    const shape = new RegExp(String.raw`(?<![\w$.'"-])${name}\s*:\s*${PROPERTY_VALUE}`, 'g');
    for (const match of stripped.matchAll(shape)) {
      if (match[2] !== ';') record(match[1], match.index ?? 0);
    }
  }

  return { usages: usages.sort(bySourceOrder), dynamic: dynamic.sort(bySourceOrder) };
}

export interface AuditInput {
  extraction: Extraction;
  /** Every locale that ships. A locale absent here is not audited. */
  catalogs: Readonly<Record<Locale, Catalog>>;
  /** Keys resolved at runtime (e.g. `time.cron.*`) — never reported unused. */
  ignoreUnused?: readonly string[];
  /** Every locale also owes each key this one defines, compared by plural stem. */
  reference?: Locale;
}

/**
 * A used key counts as present when the locale defines it *or* any of its plural
 * variants: `pl` legitimately defines `items_one`/`items_few`/`items_many` and no bare
 * `items`, and that must not read as a missing key. The same comparison serves `reference`, so
 * `ja`'s lone `items_other` answers `en`'s `items_one`/`items_other`.
 */
export function auditCatalogs(input: AuditInput): ExtractReport {
  const used = [...new Set(input.extraction.usages.map((usage) => usage.key))].sort();
  const ignore = input.ignoreUnused ?? [];
  const referenced = catalogKeys(input.catalogs[input.reference ?? ''] ?? {}).map(stemOf);
  const required = [...new Set([...used, ...referenced])].sort();

  const locales: LocaleAudit[] = Object.keys(input.catalogs)
    .sort()
    .map((locale) => {
      const catalog = input.catalogs[locale] ?? {};
      const missing = required.filter((key) => !definesKey(catalog, key));
      const usedWithVariants = new Set(used.flatMap(variantsOf));
      const unused = catalogKeys(catalog).filter(
        (key) => !usedWithVariants.has(key) && !isIgnored(key, ignore),
      );
      return { locale, missing, unused };
    });

  return {
    used,
    required,
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

/** `items_few` → `items`. Anything else is its own stem: `sort_order` is no plural. */
function stemOf(key: string): string {
  const cut = key.lastIndexOf('_');
  if (cut <= 0) return key;
  const suffix = key.slice(cut + 1);
  const plural = suffix === 'plural' || PLURAL_CATEGORIES.some((category) => category === suffix);
  return plural ? key.slice(0, cut) : key;
}

function isIgnored(key: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern,
  );
}

function bySourceOrder(a: DynamicUsage | KeyUsage, b: DynamicUsage | KeyUsage): number {
  return a.line - b.line || a.column - b.column;
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
