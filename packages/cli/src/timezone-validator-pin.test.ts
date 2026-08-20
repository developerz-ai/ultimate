// One rule, three statements of it, one answer: the pin that makes "a zone is `Area/Location`, or
// `UTC`" checkable. `@ultimat3/time` owns the rule (`zone-canonical.ts`), but `@ultimat3/core` and
// `@ultimat3/schema` are both tier 0 and may import neither it nor each other — so each carries a
// deliberate copy, and no package below tier 5 can compare them. `@ultimat3/cli` is tier 5 and may
// import all three, which is why the pin lives here, like `schema-error-codes-pin.test.ts` and
// `single-line-pin.test.ts`.

import { describe, expect, test } from 'bun:test';
import { t } from '@ultimat3/schema';
import { isValidTimeZone } from '@ultimat3/time';
// Relative, because neither predicate is part of its package's public surface — a copy that exists
// only to satisfy a tier rule should not become an exported API. `bun run boundaries` follows a
// relative specifier into another package (`cli -> core`, `cli -> schema`), so both are checked as
// the downward edges they are rather than slipping past the check.
import { isIanaZoneName as coreIsIanaZoneName } from '../../core/src/time-zone-name';
import { isIanaZoneName as schemaIsIanaZoneName } from '../../schema/src/time-zone-name';

/**
 * The three predicates, by the name a failure should report. `t.timezone` rides along as a fourth
 * entry because it is what an app actually calls: the copy and the validator wired to it can drift
 * independently, and only the wiring decides what a request body is judged by.
 */
const PREDICATES: readonly (readonly [string, (zone: string) => boolean])[] = [
  ['@ultimat3/time isValidTimeZone', isValidTimeZone],
  ['@ultimat3/core isIanaZoneName', coreIsIanaZoneName],
  ['@ultimat3/schema isIanaZoneName', schemaIsIanaZoneName],
  [
    '@ultimat3/schema t.timezone',
    (zone) => {
      // `validate` is typed as sync-or-async across the Standard Schema surface; `t.timezone` is
      // synchronous by construction, so a Promise here is a different bug and must not read as a
      // refusal — it would make every REFUSED case pass for the wrong reason.
      const result = t.timezone['~standard'].validate(zone);
      if (result instanceof Promise) expect.unreachable('t.timezone validated asynchronously');
      return result.issues === undefined;
    },
  ],
];

/**
 * The names 6.0.0 refuses. `Intl` resolves every one of them on ICU 78 (Bun 1.4) — abbreviations
 * and single-label `backward` links because the runtime bumped, a leading-sign offset because
 * ES2024 `Intl` always did — so a copy that reverts to a bare `new Intl.DateTimeFormat(…)` probe
 * fails here with the name in the report rather than in someone's request handler.
 */
const REFUSED = [
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
  'Japan',
  'GB',
  'Eire',
  'W-SU',
  'PRC',
  'ROK',
  'Singapore',
  'Israel',
  'Universal',
  '+01:00',
  '-05:00',
  '+0100',
  '-08',
  '',
  ' ',
  'Mars/Olympus',
  'Europe/Berlin ',
  'Not a zone',
];

/** The six 6.0.0 keeps: a plain zone, `UTC`, a casing of it, two aliases, and a signed name. */
const ACCEPTED = ['Europe/Berlin', 'UTC', 'utc', 'US/Eastern', 'Asia/Calcutta', 'Etc/GMT+2'];

describe('one timezone rule, three copies', () => {
  for (const [label, predicate] of PREDICATES) {
    test.each(REFUSED)(`${label} refuses %p`, (zone) => {
      expect(predicate(zone)).toBe(false);
    });

    test.each(ACCEPTED)(`${label} accepts %p`, (zone) => {
      expect(predicate(zone)).toBe(true);
    });

    /**
     * The half no hardcoded corpus can replace, because it is the only one that catches a rule
     * that got too NARROW. Every name in `REFUSED` and `ACCEPTED` would still pass under
     * `/^[A-Za-z_]+\/[A-Za-z_]+$/`, which refuses `America/Argentina/Buenos_Aires` and every
     * `Etc/GMT±n` the runtime lists — a copy tightened that way is invisible above.
     */
    test(`${label} accepts every zone the runtime itself lists`, () => {
      const listed = Intl.supportedValuesOf('timeZone');
      expect(listed.length).toBeGreaterThan(100);
      expect(listed.filter((zone) => !predicate(zone))).toEqual([]);
      expect(listed).toContain('America/Argentina/Buenos_Aires');
    });
  }

  /**
   * Agreement stated directly, not inferred from three lists passing separately: a name added to
   * `REFUSED`/`ACCEPTED` for one copy and forgotten for another would still pass above, and a name
   * in neither list is not compared at all. This one is a fold over the whole corpus plus the
   * runtime's own set, so the assertion is "they answer the same", whatever the answer is.
   */
  test('the three predicates and t.timezone answer identically over every name in play', () => {
    const corpus = [...REFUSED, ...ACCEPTED, ...Intl.supportedValuesOf('timeZone')];
    const disagreements = corpus.filter((zone) => {
      const answers = PREDICATES.map(([, predicate]) => predicate(zone));
      return answers.some((answer) => answer !== answers[0]);
    });
    expect(disagreements).toEqual([]);
  });
});
