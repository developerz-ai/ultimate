/**
 * Static extraction: which keys the source calls, which are missing per locale, which
 * are defined and never used. `x verify` fails on a missing key in a shipped locale —
 * a translation gap is a build error, not a ticket.
 */

import { stripComments } from '@ultimat3/core';
import { type Catalog, catalogKeys } from './catalog';
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
  /** Select and ordinal families with no `_other`: `<family>_other` is what each one owes. */
  incomplete: string[];
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
    String.raw`(?<![\w$.])(?:${callees.map(escapeRegExp).join('|')})(?:\.has)?\s*\(`,
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

  // Calls are found in `stripped` and KEPT only where `code` — string bodies blanked too — left the
  // call's own index as code; the argument is read off `stripped`.
  // A `// … t('…')` comment produced a phantom key `x i18n sync` would have written into every
  // catalog as `"…": "⟦…⟧"` (measured 2026-09-05), and `"use t('x.y') here"` in a fix line or a
  // docs string did the same. Both masks keep length and every newline, so an index into either is
  // an index into `source`; a template's `${…}` stays code, so a key written there is still found.
  const stripped = stripComments(source);
  const code = blankStrings(stripped);
  const argument = /\s*([^,)]*)/y;
  for (const match of stripped.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (code[index] !== stripped[index]) continue;
    argument.lastIndex = index + match[0].length;
    record(argument.exec(stripped)?.[1], index);
  }

  // Properties are read in CODE only too: a docs example quoting `{ titleKey: 'x' }` is text.
  const properties = options.properties ?? [];
  for (const property of properties) {
    const marker = property.whenFileContains;
    if (marker !== undefined && !code.includes(marker)) continue;
    const name = escapeRegExp(property.name);
    // Not after an identifier char, a `.` or a quote: `subtitleKey`, `a.titleKey`, `'x.titleKey'`.
    const shape = new RegExp(String.raw`(?<![\w$.'"-])${name}\s*:\s*${PROPERTY_VALUE}`, 'g');
    for (const match of stripped.matchAll(shape)) {
      const index = match.index ?? 0;
      if (match[2] !== ';' && code[index] === stripped[index]) record(match[1], index);
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
  // By family stem too: a locale with no grammatical gender owes `invite`, and its lone
  // `invite_select_other` answers it — never every value the reference names.
  const referenced = catalogKeys(input.catalogs[input.reference ?? ''] ?? {}).map((key) =>
    familyStemOf(stemOf(key)),
  );
  const required = [...new Set([...used, ...referenced])].sort();

  const locales: LocaleAudit[] = Object.keys(input.catalogs)
    .sort()
    .map((locale) => {
      const catalog = input.catalogs[locale] ?? {};
      const missing = required.filter((key) => !definesKey(catalog, key));
      const usedWithVariants = new Set(used.flatMap(variantsOf));
      const usedSet = new Set(used);
      // A family member is used when its stem is: `t('invite', { select })` reads every one.
      const unused = catalogKeys(catalog).filter(
        (key) =>
          !usedWithVariants.has(key) && !usedSet.has(familyStemOf(key)) && !isIgnored(key, ignore),
      );
      return {
        locale,
        missing,
        unused,
        incomplete: incompleteFamilies(catalogKeys(catalog), usedSet),
      };
    });

  return {
    used,
    required,
    usages: input.extraction.usages,
    dynamic: input.extraction.dynamic,
    locales,
    ok: locales.every((audit) => audit.missing.length === 0 && audit.incomplete.length === 0),
  };
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
  return (
    variantsOf(key).some((candidate) => Object.hasOwn(catalog, candidate)) ||
    catalogKeys(catalog).some((defined) => familyStemOf(defined) === key)
  );
}

const FAMILY = /_(select|ordinal)_/;

/** `invite_select_female_one` → `invite`; a key in no family is its own. */
function familyStemOf(key: string): string {
  const match = FAMILY.exec(key);
  return match === null || match.index === 0 ? key : key.slice(0, match.index);
}

/**
 * Every family prefix (`invite_select`, `place_ordinal`, `invite_select_female_ordinal`) whose
 * `_other` — bare or plural-suffixed — the catalog does not define: a value the family does not
 * name would render the loud miss. Answered as the key owed, `<prefix>_other`. A key source names
 * itself (`t('theme_select_label')`) is an ordinary key that happens to spell `_select_`, never a
 * family member: it owes no `theme_select_other`.
 */
function incompleteFamilies(keys: readonly string[], named: ReadonlySet<string>): string[] {
  const defined = new Set(keys);
  const owed = new Set<string>();
  for (const key of keys) {
    if (named.has(stemOf(key))) continue;
    for (const match of key.matchAll(/_(select|ordinal)_/g)) {
      if (match.index === 0) continue;
      const prefix = key.slice(0, match.index + match[0].length - 1);
      const other = `${prefix}_other`;
      const present =
        variantsOf(other).some((candidate) => defined.has(candidate)) ||
        keys.some((candidate) => candidate.startsWith(`${other}_`));
      if (!present) owed.add(other);
    }
  }
  return [...owed].sort();
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

const BLANK = '\u0000';
const WORD_CHAR = /[\w$]/;

/**
 * `text` with every string literal's contents replaced by `BLANK`, same length, so an index into it is
 * an index into `text`. A template's `${…}` is code and stays: a key can be written there.
 */
function blankStrings(text: string): string {
  let out = '';
  // One entry per open template: the brace depth of its `${…}`, or -1 while in its text.
  const templates: number[] = [];
  let quote: string | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    const top = templates.length - 1;
    const inTemplateText = quote === undefined && templates[top] === -1;
    if (quote !== undefined || inTemplateText) {
      if (char === '\\') {
        out += BLANK + (text[i + 1] === undefined ? '' : BLANK);
        i += 1;
      } else if (quote !== undefined && (char === quote || char === '\n')) {
        quote = undefined;
        out += char;
      } else if (inTemplateText && char === '`') {
        templates.pop();
        out += char;
      } else if (inTemplateText && char === '$' && text[i + 1] === '{') {
        templates[top] = 0;
        out += '${';
        i += 1;
      } else {
        out += char === '\n' ? char : BLANK;
      }
      continue;
    }
    // A quote right after an identifier char opens nothing — `foo'x'` is no JS — so it is JSX
    // text's apostrophe: `<p>Don't {t('a')}</p>` read as an opener blanked the call after it.
    if ((char === "'" || char === '"') && !WORD_CHAR.test(text[i - 1] ?? '')) quote = char;
    else if (char === '`') templates.push(-1);
    else if (top >= 0 && char === '{') templates[top] = (templates[top] ?? 0) + 1;
    else if (top >= 0 && char === '}') {
      const depth = templates[top] ?? 0;
      templates[top] = depth === 0 ? -1 : depth - 1;
    }
    out += char;
  }
  return out;
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
