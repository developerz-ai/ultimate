// Single responsibility: `app.config.ts` is a CLOSED shape — a key the framework does not declare,
// at any depth and in any layer, is refused by path with the key it most likely meant. A key that
// is merged and read by nothing is the switch with no wire, and a typo (`drian`) is the same defect.

import { BASE_FIX } from './config-fixes';
import type { MailRetainMimeConfig } from './config-mail';
import type { NavigationConfig, SpeculationConfig } from './config-navigation';
import type {
  PwaColors,
  PwaConfig,
  PwaImage,
  PwaSchemeColors,
  PwaScreenshot,
  PwaShortcut,
} from './config-pwa';
import { ConfigInvalidError } from './errors';
import { isJsonObject } from './json-object';
import { nearestName } from './nearest-name';

type Unlisted<T, K extends readonly string[]> = Exclude<keyof T & string, K[number]>;

/**
 * Every key of `T`, or a type error naming the one left out: a member added to an interface below
 * without a row here would be a key the screen refuses, so the omission is `tsc`'s, not an app's.
 */
const keysOf =
  <T>() =>
  <const K extends readonly (keyof T & string)[]>(
    keys: K & ([Unlisted<T, K>] extends [never] ? unknown : { readonly unlisted: Unlisted<T, K> }),
  ): K =>
    keys;

/**
 * The sections the DEFAULTS cannot show: optional members with no default (`pwa.id`), blocks that
 * default to `undefined` or `false` (`pwa.colors`, `mail.retainMime`), list elements (`[]`), and
 * `navigation`, which `defineConfig` leaves out of its shape reference. Everywhere else the known
 * keys are the defaults' own — derived, never a second hand list.
 */
export const SECTION_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  pwa: keysOf<PwaConfig>()([
    'enabled',
    'offline',
    'backgroundSync',
    'push',
    'name',
    'colors',
    'id',
    'description',
    'categories',
    'shortcuts',
    'screenshots',
  ]),
  'pwa.colors': keysOf<PwaColors>()(['light', 'dark']),
  'pwa.colors.light': keysOf<PwaSchemeColors>()(['themeColor', 'backgroundColor']),
  'pwa.colors.dark': keysOf<PwaSchemeColors>()(['themeColor', 'backgroundColor']),
  'pwa.shortcuts[]': keysOf<PwaShortcut>()(['name', 'shortName', 'description', 'url', 'icons']),
  'pwa.shortcuts[].icons[]': keysOf<PwaImage>()(['src', 'sizes', 'type', 'purpose']),
  'pwa.screenshots[]': keysOf<PwaScreenshot>()(['src', 'sizes', 'type', 'formFactor', 'label']),
  'mail.retainMime': keysOf<MailRetainMimeConfig>()(['maxBytes']),
  navigation: keysOf<NavigationConfig>()(['client', 'speculation']),
  'navigation.speculation': keysOf<SpeculationConfig>()(['prefetch', 'exclude']),
});

/**
 * The positions whose KEYS the app chooses, never walked: each is a `PwaText`, one string or a
 * record keyed by locale tag (`{ en: …, 'es-co': … }`), and a locale is not a key this file knows.
 */
export const OPEN_CONFIG_PATHS: ReadonlySet<string> = new Set([
  'pwa.description',
  'pwa.shortcuts[].name',
  'pwa.shortcuts[].shortName',
  'pwa.shortcuts[].description',
  'pwa.screenshots[].src',
  'pwa.screenshots[].label',
]);

export interface UnknownConfigKey {
  /** As an app reads it: `pwa.shortcuts[0].href`. */
  readonly path: string;
  /** The keys its section does hold, in declared order. */
  readonly known: readonly string[];
  /** The nearest of `known`, when one is close enough to be the typo. */
  readonly near: string | undefined;
}

const join = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`);

/**
 * CLOSED BY DEFAULT: an object is walked wherever it is written, its known keys the reference's
 * plus `SECTION_KEYS`' — so an object at a key whose default is `undefined` (`realtime.urlEnv`)
 * knows no keys and every one is refused. Two exceptions: `OPEN_CONFIG_PATHS`, and a position the
 * defaults hold a VALUE at (`site.origin: null`), whose own rule names the wrong value in better
 * words than "unknown key".
 */
/** `SECTION_KEYS`' row for `path`, own keys only: a layer key `constructor` must not read the prototype. */
const sectionKeysAt = (path: string): readonly string[] | undefined =>
  Object.hasOwn(SECTION_KEYS, path) ? SECTION_KEYS[path] : undefined;

function walk(
  reference: unknown,
  layer: unknown,
  at: { readonly schema: string; readonly shown: string },
  found: UnknownConfigKey[],
): void {
  if (OPEN_CONFIG_PATHS.has(at.schema)) return;
  if (Array.isArray(layer)) {
    // A list's elements are walked only where an element is a declared section (`pwa.shortcuts`);
    // `jobs.queues` holds names, and a wrong element there is the name screen's to refuse.
    const element = `${at.schema}[]`;
    if (sectionKeysAt(element) === undefined) return;
    for (const [index, item] of layer.entries()) {
      walk(undefined, item, { schema: element, shown: `${at.shown}[${index}]` }, found);
    }
    return;
  }
  if (!isJsonObject(layer)) return;
  const declared = sectionKeysAt(at.schema);
  if (declared === undefined && reference !== undefined && !isJsonObject(reference)) return;
  const ref = isJsonObject(reference) ? reference : {};
  const known = [...new Set([...Object.keys(ref), ...(declared ?? [])])];
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined) continue;
    const next = { schema: join(at.schema, key), shown: join(at.shown, key) };
    if (!known.includes(key)) {
      found.push({ path: next.shown, known, near: nearestName(key, known) });
      continue;
    }
    walk(ref[key], value, next, found);
  }
}

/** Every key one layer writes that `reference` (the defaults) and `SECTION_KEYS` do not declare. */
export function unknownConfigKeys(reference: unknown, layer: unknown): readonly UnknownConfigKey[] {
  const found: UnknownConfigKey[] = [];
  walk(reference, layer, { schema: '', shown: '' }, found);
  return found;
}

const parentOf = (path: string): string => {
  const cut = path.lastIndexOf('.');
  return cut === -1 ? '' : path.slice(0, cut);
};

const issueOf = (key: UnknownConfigKey): string =>
  `${key.path} is not an app.config.ts key${key.near === undefined ? '' : ` — did you mean ${key.near}?`}`;

const holds = (key: UnknownConfigKey): string =>
  key.known.length === 0
    ? `${parentOf(key.path)} is a value, not a section`
    : `${parentOf(key.path) || 'the top level'} holds ${key.known.join(', ')}`;

const fixOf = (key: UnknownConfigKey): string =>
  key.near === undefined
    ? `delete ${key.path} from app.config.ts — ${holds(key)}`
    : `rename ${key.path} to ${join(parentOf(key.path), key.near)} in app.config.ts`;

/**
 * Every layer asked, so a stale `config/realtime.ts` overlay is caught as surely as the base, and
 * every unknown key named in ONE refusal rather than one per restart.
 */
export function refuseUnknownKeys(reference: unknown, layers: readonly unknown[]): void {
  const unknown = layers.flatMap((layer) => unknownConfigKeys(reference, layer));
  if (unknown.length === 0) return;
  const issues = unknown.map(issueOf);
  throw new ConfigInvalidError({
    cause: issues.join('; '),
    fix: [...new Set(unknown.map(fixOf)), BASE_FIX].join('. '),
    meta: { issues, unknown: [...new Set(unknown.map((key) => key.path))] },
  });
}
