/**
 * Speculation Rules for a document that carries NO client router: the browser fetches a link's
 * document before the click, so a full-page navigation paints from memory — at zero JavaScript.
 * Pure functions over patterns; which pages are candidates is the caller's (`@ultimat3/cli`).
 * PREFETCH only: a prerender would run the next page's scripts for a page nobody opened.
 */

import type { HeadTag } from './head';

/** The `<script type>` a browser reads as rules and never executes. */
export const SPECULATION_RULES_TYPE = 'speculationrules';

export interface SpeculationRules {
  /** `moderate`: pointer rest or pointer down. `conservative`: pointer down only. */
  readonly eagerness: 'moderate' | 'conservative';
  /** URL patterns of the documents that may be fetched early. Empty: no rules at all. */
  readonly include: readonly string[];
  /** URL patterns removed from `include` — the app's own `navigation.speculation.exclude`. */
  readonly exclude: readonly string[];
}

/** Characters with a meaning in a URL pattern's pathname, escaped in a literal segment. */
const PATTERN_SYNTAX = /[\\{}()*+?:]/g;

/** A name a URL pattern accepts after `:` — anything else is matched as an unnamed segment. */
const GROUP_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function patternSegment(segment: string): string {
  if (segment.startsWith('*')) return '*';
  if (segment.startsWith(':')) return GROUP_NAME.test(segment.slice(1)) ? segment : '([^/]+)';
  return segment.replace(PATTERN_SYNTAX, (char) => `\\${char}`);
}

/**
 * A route-table path as the URL pattern that matches it in every routed locale: `/blog/:slug` with
 * `['en']` → `{/en}?/blog/:slug`. `localeSegments` are the NON-default locales' URL segments; the
 * default locale is the unprefixed path. A catch-all (`/docs/*path`) becomes a wildcard.
 */
export function speculationPattern(path: string, localeSegments: readonly string[] = []): string {
  const pattern = path.split('/').map(patternSegment).join('/');
  if (localeSegments.length === 0) return pattern;
  const [only] = localeSegments;
  const group = localeSegments.length === 1 ? only : `(${localeSegments.join('|')})`;
  return `{/${group}}?${pattern}`;
}

/**
 * The exact text between the tags, or `undefined` when nothing may be fetched early. Sorted and
 * deduped, so one route table is one string — the CSP source is hashed from THIS string, and a body
 * that moved with registration order would be a policy that admits yesterday's document. `<` is
 * written `<` (the same character to a JSON parser), so no pattern can close the element and
 * `renderHead`'s raw-text escaper has nothing left to rewrite.
 */
export function speculationRulesBody(rules: SpeculationRules): string | undefined {
  const sorted = (patterns: readonly string[]): readonly string[] => [...new Set(patterns)].sort();
  const include = sorted(rules.include);
  if (include.length === 0) return undefined;
  const exclude = sorted(rules.exclude);
  const matches = { href_matches: include };
  const where =
    exclude.length === 0 ? matches : { and: [matches, { not: { href_matches: exclude } }] };
  return JSON.stringify({ prefetch: [{ where, eagerness: rules.eagerness }] }).replaceAll(
    '<',
    '\\u003c',
  );
}

/** The tag for a body `speculationRulesBody` wrote. No attribute but `type`: the hash is the body's. */
export function speculationRulesTag(body: string): HeadTag {
  return {
    kind: 'script',
    key: 'script:speculation-rules',
    attrs: { type: SPECULATION_RULES_TYPE },
    content: body,
  };
}
