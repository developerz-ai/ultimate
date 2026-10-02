// Single responsibility: the SHAPE half of `app.config.ts` validation — is this a section, a list,
// a boolean, one of a closed set — asked before any rule reads the value. Takes every key as a
// string and every value as `unknown`, and names no config key of its own: `config-readers` counts
// a property access outside the declaring files as a reader, so this file must not make one.

import { describeValue } from './error-render';
import { isJsonObject } from './json-object';

/** A string is worth echoing — it is the typo; anything else is described by shape. */
const said = (value: unknown): string =>
  typeof value === 'string' ? `"${value}"` : describeValue(value);

/**
 * Every section and list one LAYER wrote, compared with the same position in `reference` — the
 * defaults merged with no layer, so the screen is derived and never a hand list of key names.
 * Structure only: where the reference holds a section the layer may hold a section, where it holds
 * a list, a list. `undefined` is a layer not saying; scalars are the per-key rules' business; and
 * a position the reference leaves `null` or `undefined` (an optional block) is not judged here.
 *
 * It runs BEFORE the merge and its issues end the validation, because the merge and every rule
 * after it read through the structure: `Object.entries(null)` and `null.length` are the native
 * `TypeError`s the validator exists to replace with an instruction.
 */
export function shapeIssues(reference: unknown, layer: unknown, issues: string[], path = ''): void {
  if (!isJsonObject(reference) || !isJsonObject(layer)) return;
  for (const [key, expected] of Object.entries(reference)) {
    const at = path === '' ? key : `${path}.${key}`;
    const value: unknown = layer[key];
    if (value === undefined) continue;
    if (Array.isArray(expected)) {
      if (!Array.isArray(value)) issues.push(`${at} must be a list, not ${describeValue(value)}`);
    } else if (isJsonObject(expected)) {
      if (isJsonObject(value)) shapeIssues(expected, value, issues, at);
      else issues.push(`${at} must be an object, not ${describeValue(value)}`);
    }
  }
}

/** Why `value` is not one of `allowed`, or `undefined` when it is. */
export function oneOfIssue(
  key: string,
  value: unknown,
  allowed: readonly string[],
): string | undefined {
  if (allowed.some((known) => known === value)) return undefined;
  return `${key} ${said(value)} is not one of ${allowed.join(', ')}`;
}

/**
 * `typeof`, never truthiness: an untyped config writing `'false'` — a string out of an environment
 * variable — is truthy, so the switch it meant to turn off stayed on and nothing said so.
 */
export function booleanIssue(key: string, value: unknown): string | undefined {
  return typeof value === 'boolean'
    ? undefined
    : `${key} must be true or false, not ${said(value)}`;
}

/** A route path the framework mounts or redirects to: absolute, or the browser resolves it. */
export function routePathIssue(key: string, value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith('/')
    ? undefined
    : `${key} must be a path starting with /, not ${said(value)}`;
}

/** A list that names things: at least one entry, each a non-empty string, `what` each. */
export function nameListIssues(
  key: string,
  list: readonly unknown[],
  what: string,
  issues: string[],
): void {
  if (list.length === 0) issues.push(`${key} must list at least one ${what}`);
  for (const entry of list) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      issues.push(`${key} contains ${said(entry)}, not a ${what} name`);
    }
  }
}

function canonicalTag(tag: unknown): string | undefined {
  if (typeof tag !== 'string') return undefined;
  try {
    const canonical = Intl.getCanonicalLocales(tag);
    return canonical.length === 1 ? canonical[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The locale list and the tag that must be in it. Two spellings of ONE locale are refused: the
 * list keys a catalog, a route prefix and an `hreflang` each, and `['EN', 'en']` is two of every
 * one of them for a single language.
 */
export function localeIssues(tags: readonly unknown[], fallback: unknown, issues: string[]): void {
  if (tags.length === 0) issues.push('locales must list at least one locale');
  const seen = new Map<string, unknown>();
  for (const tag of tags) {
    const canonical = canonicalTag(tag);
    if (canonical === undefined) {
      issues.push(`locales contains ${said(tag)}, not a BCP-47 tag`);
    } else if (seen.has(canonical)) {
      issues.push(
        `locales lists ${canonical} twice, as ${said(seen.get(canonical))} and ${said(tag)}`,
      );
    } else {
      seen.set(canonical, tag);
    }
  }
  if (!tags.includes(fallback)) issues.push(`defaultLocale ${said(fallback)} is not in locales`);
}
