// Single responsibility: environment → purge driver. The one place that decides which CDN a boot
// purges against, so `x dev`, a worker container and any custom host resolve it identically. Keyed
// on env rather than an `app.config.ts` field because nothing loads that file's contents at
// runtime — a `cache.cdn` block would be a setting no boot could read.

import { ConfigInvalidError } from '@ultimat3/core';
import type { PurgeDriver } from './cdn';
import { noopPurgeDriver } from './cdn';
import { cloudflarePurgeDriver } from './purge-cloudflare';
import { fastlyPurgeDriver } from './purge-fastly';

/** The keys read here, and nothing else. Named once so docs and tests cannot drift from the code. */
export const CDN_PURGE_ENV_KEYS = [
  'FASTLY_API_TOKEN',
  'FASTLY_SERVICE_ID',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ZONE_ID',
] as const;

export type PurgeEnvironment = Readonly<Record<string, string | undefined>>;

export interface PurgeSelection {
  readonly driver: PurgeDriver;
  /**
   * Why this driver, in one line: the env key that selected it, or what to set to change it.
   * A boot prints it, so "does this replica purge anything" is never a guess. The key's name
   * only — `FASTLY_API_TOKEN` holds a credential, and this string reaches a log.
   */
  readonly detail: string;
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim().length === 0 ? undefined : value.trim();

/** A driver that reaches no CDN, so a caller can report "purges nothing" without a name match. */
export const isNoopPurgeDriver = (driver: PurgeDriver): boolean => driver.name === 'noop';

/**
 * Either key selects its provider, and the other is then required: a `FASTLY_SERVICE_ID` with no
 * token is a half-finished deploy, and treating it as "no CDN" is how an environment ships
 * believing it purges. The pair is named in the cause, so the missing half is the fix.
 */
function requirePair(env: PurgeEnvironment, selectedBy: string, missingKey: string): string {
  const value = nonEmpty(env[missingKey]);
  if (value === undefined) {
    throw new ConfigInvalidError({
      cause: `${selectedBy} selects a CDN purge driver, but ${missingKey} is unset — the pair is incomplete`,
      fix: `set ${missingKey} in .env.production, or unset ${selectedBy} to purge nothing`,
      meta: { selectedBy, missing: missingKey },
    });
  }
  return value;
}

/**
 * A credential selects its CDN; no credential purges nothing, which is the honest default for a
 * process with no edge in front of it. Two CDNs at once is refused rather than resolved: whichever
 * this picked would be the one an operator did not mean half the time, and the other edge would
 * serve a stale page nobody can explain.
 */
export function selectPurgeDriver(env: PurgeEnvironment): PurgeSelection {
  const fastlyKey = nonEmpty(env['FASTLY_API_TOKEN']) ?? nonEmpty(env['FASTLY_SERVICE_ID']);
  const cloudflareKey =
    nonEmpty(env['CLOUDFLARE_API_TOKEN']) ?? nonEmpty(env['CLOUDFLARE_ZONE_ID']);

  if (fastlyKey !== undefined && cloudflareKey !== undefined) {
    throw new ConfigInvalidError({
      cause: 'FASTLY_* and CLOUDFLARE_* are both set — two CDNs claim the same purge',
      fix: 'unset one pair in .env.production: a process purges exactly one edge',
      meta: { selected: ['FASTLY_API_TOKEN', 'CLOUDFLARE_API_TOKEN'] },
    });
  }

  if (fastlyKey !== undefined) {
    return {
      driver: fastlyPurgeDriver({
        apiToken: requirePair(env, 'FASTLY_SERVICE_ID', 'FASTLY_API_TOKEN'),
        serviceId: requirePair(env, 'FASTLY_API_TOKEN', 'FASTLY_SERVICE_ID'),
      }),
      detail: 'FASTLY_API_TOKEN',
    };
  }

  if (cloudflareKey !== undefined) {
    return {
      driver: cloudflarePurgeDriver({
        apiToken: requirePair(env, 'CLOUDFLARE_ZONE_ID', 'CLOUDFLARE_API_TOKEN'),
        zoneId: requirePair(env, 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ZONE_ID'),
      }),
      detail: 'CLOUDFLARE_API_TOKEN',
    };
  }

  return {
    driver: noopPurgeDriver(),
    detail:
      'no edge in front of this process — set FASTLY_API_TOKEN + FASTLY_SERVICE_ID, or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID',
  };
}
