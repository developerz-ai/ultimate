/**
 * One IANA zone, one key. `Intl` accepts every casing of a zone name, so `Europe/Berlin` and
 * `eUrOpE/bErLiN` reach a formatter cache — and every downstream comparison — as two zones.
 * A 13-letter name has 2^12 casings and a request header can name any of them.
 */

import { cachedFormatter } from '@ultimat3/core';

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
 * Deprecated aliases (`US/Eastern`, `Asia/Calcutta`) are not in the listed set — `supportedValuesOf`
 * holds canonical zones only, and ICU does not fold a `backward` link into its target — so they
 * take the `resolve` probe once, as do the runtime's extras (`EST`, `GMT`), the aliases to be
 * accepted and the extras refused. Both cached: either can arrive from a header on every request.
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

/**
 * `Intl` answers "can I format this", never "is this an IANA zone", and the two stopped agreeing:
 * ICU 78 (Bun 1.4) resolves `CET`, `EST`, `EST5EDT`, `GMT` and `MST` where ICU 75 threw, so a
 * runtime upgrade alone reopened the guard — silently, and in the direction that fails dangerous,
 * because an abbreviation names no DST rule. The IANA-ness judgement is therefore never delegated
 * to `Intl`: an identifier is `Area/Location`, and `UTC` is the one legal exception.
 *
 * That refuses the single-label `backward` links (`Japan`, `GB`, `Eire`) along with the
 * abbreviations, and it is meant to. No structural rule keeps `CET` out and lets `Japan` in — both
 * are one label — and the alternative is a denylist that grows with every tzdata and ICU release.
 * `Asia/Tokyo` is the spelling that survives being a formatter-cache key, which is what this file
 * is for. `Etc/GMT+2` passes: the `+` is inside a real zone name, and only a LEADING sign is a
 * bare offset.
 *
 * `UTC` is compared on the RESOLVED name rather than assumed unreachable. It is unreachable today
 * — `UTC` is in `supportedValuesOf` and never gets this far — but a runtime that folds an alias
 * into its target would resolve `Etc/UTC` to `UTC`, and refusing `Etc/UTC` would be the bug.
 */
function resolve(zone: string): string | '' {
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions()
      .timeZone;
    return resolved === 'UTC' || resolved.includes('/') ? resolved : '';
  } catch {
    return '';
  }
}
