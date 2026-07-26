/**
 * Resolve the request timezone once, then read it from the ALS context.
 * User record → header → config default. Every formatter still takes the zone
 * explicitly; this is where call sites get the value from, not a hidden default.
 */

import { type Ctx, useContext } from '@ultimat3/core';
import { isValidTimeZone, type TimeZone, UTC } from './zones';

/** Header a client sets from `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
export const TIMEZONE_HEADER = 'x-timezone';

const CTX_TIMEZONE = 'timeZone';

export interface TimeZoneSources {
  /** `user.timeZone` — an explicit preference beats a browser guess. */
  user?: string | null;
  /** `x-timezone` request header. */
  header?: string | null;
  /** `?tz=Europe/Berlin`, for share links and email previews. */
  query?: string | null;
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

let config: TimeConfig = { defaultZone: UTC, order: ['user', 'header', 'query'] };

export function configureTime(partial: Partial<TimeConfig>): TimeConfig {
  config = { ...config, ...partial };
  return config;
}

export function timeConfig(): TimeConfig {
  return config;
}

/**
 * First valid IANA name wins. An invalid value is skipped, never thrown: a stale
 * `x-timezone` header from an old client must not fail the request.
 */
export function resolveTimeZone(
  sources: TimeZoneSources,
  overrides: Partial<TimeConfig> = {},
): TimeZoneResolution {
  const { defaultZone, order } = { ...config, ...overrides };
  for (const name of order) {
    const candidate = sources[name];
    if (candidate === undefined || candidate === null || candidate === '') continue;
    if (isValidTimeZone(candidate)) return { zone: candidate, source: name };
  }
  return { zone: defaultZone, source: 'default' };
}

/** Called once per request by the HTTP layer. */
export function attachTimeZone(ctx: Ctx, zone: TimeZone): TimeZone {
  (ctx as unknown as Record<string, unknown>)[CTX_TIMEZONE] = zone;
  return zone;
}

export function timeZoneOf(ctx: Ctx): TimeZone {
  return readField(ctx, CTX_TIMEZONE) ?? config.defaultZone;
}

/** Ambient zone for the in-flight request; the configured default outside one. */
export function currentTimeZone(): TimeZone {
  const ctx = tryContext();
  return (ctx === undefined ? undefined : readField(ctx, CTX_TIMEZONE)) ?? config.defaultZone;
}

function tryContext(): Ctx | undefined {
  try {
    return useContext();
  } catch {
    // Outside a request scope (boot, worker tick, CLI) — fall back to the configured zone.
    return undefined;
  }
}

/** `Ctx` belongs to core (tier 0) and cannot import `TimeZone`; read the field structurally. */
function readField(ctx: Ctx, field: string): string | undefined {
  const value = (ctx as unknown as Record<string, unknown>)[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
