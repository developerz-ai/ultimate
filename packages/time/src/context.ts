/**
 * Resolve the request timezone once, then read it from the ALS context.
 * Explicit preference → chosen → browser guess → config default. Every formatter still takes the
 * zone explicitly; this is where call sites get the value from, not a hidden default.
 */

import { tryUseContext } from '@ultimat3/core';
import { canonicalTimeZone } from './zone-canonical';
import { assertTimeZone, type TimeZone, UTC } from './zones';

/** Header a client sets from `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
export const TIMEZONE_HEADER = 'x-timezone';

export interface TimeZoneSources {
  /** `user.timeZone` — an explicit preference beats a browser guess. */
  user?: string | null;
  /** The cookie a zone picker writes — chosen, so it beats what the browser was installed as. */
  cookie?: string | null;
  /** `?tz=Europe/Berlin`, for share links and email previews. */
  query?: string | null;
  /** `x-timezone` request header. */
  header?: string | null;
}

export type TimeZoneSourceName = keyof TimeZoneSources;

export interface TimeZoneResolution {
  zone: TimeZone;
  source: TimeZoneSourceName | 'default';
}

export interface TimeConfig {
  /** The zone used when nothing else resolves. UTC unless the app says otherwise. */
  defaultZone: TimeZone;
  order: readonly TimeZoneSourceName[];
}

/**
 * Explicit before inferred, the same rule `@ultimat3/i18n`'s locale order states: `Accept-Language`
 * and `x-timezone` are what the browser was installed as, while the user row, the cookie and the
 * query are what a person *chose*. A zone picker that wrote a cookie the header always outranked
 * would appear to do nothing.
 */
const DEFAULT_ORDER: readonly TimeZoneSourceName[] = ['user', 'cookie', 'query', 'header'];

let config: TimeConfig = { defaultZone: UTC, order: DEFAULT_ORDER };

/**
 * The default zone goes through `assertTimeZone`, which both VALIDATES and CANONICALIZES — the two
 * halves `resolveTimeZone` already promises for every other source, on the one source that skipped
 * them. Unchecked, `configureTime({ defaultZone: 'Mars/Olympus' })` was accepted at boot and first
 * refused inside a formatter at render time, from a stack that names no configuration; and
 * `'eUrOpE/bErLiN'` travelled the process as its own zone string, minting a permanent entry in
 * every formatter cache it reached.
 *
 * It throws, where `resolveTimeZone` skips: a stale header from an old client must not fail a
 * request, but a default nothing can fall back to is a boot-time mistake with no second answer.
 */
export function configureTime(partial: Partial<TimeConfig>): TimeConfig {
  const defaultZone =
    partial.defaultZone === undefined ? undefined : assertTimeZone(partial.defaultZone);
  config = {
    ...config,
    ...partial,
    ...(defaultZone === undefined ? {} : { defaultZone }),
  };
  return config;
}

export function timeConfig(): TimeConfig {
  return config;
}

/**
 * First valid IANA name wins, **canonicalized**. An invalid value is skipped, never thrown: a
 * stale `x-timezone` header from an old client must not fail the request.
 *
 * The canonical spelling is what leaves this function, because `Intl` accepts every casing:
 * `x-timezone: eUrOpE/bErLiN` used to travel the whole request as its own distinct zone string,
 * and every formatter cache it reached kept a permanent entry for it.
 */
export function resolveTimeZone(
  sources: TimeZoneSources,
  overrides: Partial<TimeConfig> = {},
): TimeZoneResolution {
  const { defaultZone, order } = { ...config, ...overrides };
  for (const name of order) {
    const candidate = sources[name];
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const zone = canonicalTimeZone(candidate);
    if (zone !== undefined) return { zone, source: name };
  }
  return { zone: defaultZone, source: 'default' };
}

/**
 * Ambient zone for the in-flight request; the configured default outside one.
 *
 * The store is **`Ctx.tz`**, core's own declared field — never a second one this package writes.
 * It used to be a `ctx['timeZone']` key nothing in the framework ever set, while the HTTP pipeline
 * wrote `ctx.tz`: two ambient answers to one question, and the one every `@ultimat3/ui` component
 * reads on a server render was the empty one, so every date rendered in UTC however the request
 * arrived. `withChildContext({ tz })` and `createContext({ tz })` are therefore the only writers,
 * which is what makes a subtree's zone a core concept rather than this package's.
 */
export function currentTimeZone(): TimeZone {
  const zone = tryUseContext()?.tz;
  return zone === undefined || zone === '' ? config.defaultZone : zone;
}
