/**
 * One IANA zone, one key. `Intl` accepts every casing of a zone name, so `Europe/Berlin` and
 * `eUrOpE/bErLiN` reach a formatter cache — and every downstream comparison — as two zones.
 * A 13-letter name has 2^12 casings and a request header can name any of them.
 */

import { cachedFormatter } from './intl-cache';

/** ES2024 `Intl` accepts `+01:00` as a zone; we do not — a fixed offset has no DST rules. */
const NUMERIC_OFFSET = /^[+-]/;

/**
 * Lowercase → canonical, for every zone the runtime lists. Built once, ~445 entries, and it is
 * what makes the common case — a casing of a real zone — cost a string lookup instead of an
 * `Intl.DateTimeFormat` construction the caller can mint at will.
 */
let listed: Map<string, string> | undefined;

function listedZones(): Map<string, string> {
  if (listed !== undefined) return listed;
  const table = new Map<string, string>();
  for (const zone of Intl.supportedValuesOf('timeZone')) table.set(zone.toLowerCase(), zone);
  listed = table;
  return table;
}

/**
 * Deprecated aliases (`US/Eastern`, `Asia/Calcutta`) and the runtime's extras (`EST`, `GMT`) are
 * not in the listed set, so they take the `Intl` probe once — bounded for the same reason every
 * other cache here is.
 */
const probed = new Map<string, string | ''>();

/**
 * The canonical spelling of an IANA zone, or `undefined` for anything that is not one.
 * `'CET'` and `'+01:00'` are not zones: an abbreviation is ambiguous and an offset has no rules.
 */
export function canonicalTimeZone(zone: string): string | undefined {
  if (zone === '' || NUMERIC_OFFSET.test(zone)) return undefined;
  const known = listedZones().get(zone.toLowerCase());
  if (known !== undefined) return known;
  // `''` is the cached "not a zone" answer — a `Map` miss and a cached refusal must not look the
  // same, or every invalid header re-probes `Intl` forever.
  const resolved = cachedFormatter(probed, zone, () => resolve(zone));
  return resolved === '' ? undefined : resolved;
}

function resolve(zone: string): string | '' {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return '';
  }
}
