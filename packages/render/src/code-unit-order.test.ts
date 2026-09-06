// The comparator's claim is a comparison with `localeCompare`, so the test has to make it: an
// assertion that only says "this is sorted" passes under either rule.

import { describe, expect, test } from 'bun:test';
import { byCodeUnit } from './code-unit-order';

describe('byCodeUnit', () => {
  // Every `localeCompare` here NAMES its locale, and the assertions about the comparator do not
  // call it at all. A bare `localeCompare` reads the runtime's ICU default — the very thing this
  // comparator exists to avoid — so a test asserting its answer is a test whose verdict moves with
  // `LANG`, on a CI runner or a laptop. The disagreement is still shown, under a locale that
  // cannot drift.
  test('orders by code unit, which is where the ICU default disagrees', () => {
    // Case: `'/A'` (0x41) before `'/a'` (0x61). `en-US` folds case and inverts this.
    expect(byCodeUnit('/A', '/a')).toBe(-1);
    expect('/A'.localeCompare('/a', 'en-US')).toBe(1);

    // Punctuation: `'_'` (0x5F) after `'1'` (0x31). `en-US` puts punctuation first.
    expect(byCodeUnit('/_', '/1')).toBe(1);
    expect('/_'.localeCompare('/1', 'en-US')).toBe(-1);
  });

  test('is stable under a locale that reorders letters, which is the deploy-diff property', () => {
    // `sv-SE` sorts `ä` after `z`; `en-US` sorts it with `a`. Code units answer once, everywhere.
    expect(byCodeUnit('/zoo', '/ärzte')).toBe(-1);
    expect('/zoo'.localeCompare('/ärzte', 'sv-SE')).toBe(-1);
    expect('/zoo'.localeCompare('/ärzte', 'en-US')).toBe(1);
  });

  test('answers 0 only for equal strings, so a sort using it is stable', () => {
    expect(byCodeUnit('/a', '/a')).toBe(0);
  });
});
