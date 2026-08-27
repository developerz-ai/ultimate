import { describe, expect, test } from 'bun:test';
import { isIanaZoneName } from './time-zone-name';

/**
 * **A MIRROR of `isValidTimeZone`'s corpus in `packages/time/src/zones.test.ts`, name for name, and
 * it must move with it.**
 *
 * The predicate itself is no longer duplicated: `core -> schema` is a declared edge `As of
 * 2026-08-27` and this module re-exports `@ultimat3/schema`'s `isIanaZoneName`, so the config
 * validator and `t.timezone` are one function. What is still stated twice is
 * `@ultimat3/time`'s `canonicalTimeZone`, which answers a DIFFERENT question — the canonical
 * spelling, memoised over the runtime's ~445 listed zones plus a probe cache — and shares only the
 * leading-sign rule. Collapsing it would trade a cache a request header can hit for one it cannot.
 *
 * So this corpus is the local half of THAT comparison: a name added to either and not the other
 * shows up as a divergence in review rather than as an `app.config.ts` that boots on a zone every
 * `format` call below it refuses.
 */
describe('isIanaZoneName', () => {
  // ICU 78 (Bun 1.4) RESOLVES every one of these where ICU 75 threw, which is exactly how the bare
  // `Intl` probe this replaced started disagreeing with `@ultimat3/time`. One case per name, named,
  // so a later ICU bump that reopens one fails with the name in the report.
  const ABBREVIATIONS = [
    'CET',
    'EET',
    'MET',
    'WET',
    'EST',
    'MST',
    'HST',
    'GMT',
    'GMT0',
    'UCT',
    'Zulu',
    'EST5EDT',
    'CST6CDT',
    'MST7MDT',
    'PST8PDT',
  ];

  test.each(ABBREVIATIONS)('refuses %s — an abbreviation carries no DST rule', (zone) => {
    expect(isIanaZoneName(zone)).toBe(false);
    // Every casing, because `Intl` accepts every casing of every name it accepts at all.
    expect(isIanaZoneName(zone.toLowerCase())).toBe(false);
  });

  // Single-label `backward` links name real zones, and refusing them is deliberate rather than ICU
  // drift: no structural rule keeps `CET` out and lets `Japan` in, both being one label.
  test.each(['Japan', 'GB', 'Eire', 'W-SU', 'PRC', 'ROK', 'Singapore', 'Israel', 'Universal'])(
    'refuses the single-label legacy link %s',
    (zone) => {
      expect(isIanaZoneName(zone)).toBe(false);
    },
  );

  // A fixed offset has no DST rules, and ES2024 `Intl` accepted these long before ICU 78 — so this
  // class was reaching `app.config.ts` under every runtime the framework has ever shipped on.
  test.each(['+01:00', '-05:00', '+0100', '-08'])('refuses the bare offset %s', (zone) => {
    expect(isIanaZoneName(zone)).toBe(false);
  });

  test.each(['Europe/Berlin', 'UTC', 'utc', 'US/Eastern', 'Asia/Calcutta', 'Etc/GMT+2'])(
    'still accepts %s',
    (zone) => {
      expect(isIanaZoneName(zone)).toBe(true);
    },
  );

  test.each(['', ' ', 'Mars/Olympus', 'Europe/Berlin ', 'Not a zone'])(
    'refuses %p, which is not a zone at all',
    (zone) => {
      expect(isIanaZoneName(zone)).toBe(false);
    },
  );

  /**
   * The other direction, and the reason it is not just a longer hardcoded list: the rule must be
   * exactly as wide as the runtime's own canonical set, and nothing in the corpus above would
   * notice a rule that narrowed — `/^[A-Za-z_]+\/[A-Za-z_]+$/` refuses
   * `America/Argentina/Buenos_Aires` and `Etc/GMT+2` while passing every case above it.
   */
  test('accepts every zone the runtime itself lists, three-part and signed names included', () => {
    const listed = Intl.supportedValuesOf('timeZone');
    expect(listed.length).toBeGreaterThan(100);
    expect(listed.filter((zone) => !isIanaZoneName(zone))).toEqual([]);
    expect(listed).toContain('America/Argentina/Buenos_Aires');
  });
});
