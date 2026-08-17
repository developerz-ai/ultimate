// `@ultimat3/core` carries a deliberate duplicate of `@ultimat3/schema`'s `CURRENCY_CODE_PATTERN`
// (`config.ts`'s `CURRENCY_RE`), because both are tier 0 and `core → schema` is in no
// `SIDEWAYS_ALLOW` entry — the same wall that makes `describeValue` a character-for-character copy.
// Core's own corpus test guards core; nothing could guard the pair, and the direction that breaks
// the contract is a change in SCHEMA, whose constant is what the published OpenAPI `pattern` and
// `@ultimat3/entity`'s Postgres CHECK are derived from. `@ultimat3/cli` is tier 5 and may import
// both, so the pin lives here — the precedent `schema-error-codes-pin.test.ts` already set.
//
// Compared through public surfaces only, and deliberately so: a regex exported for a test to read
// is an export the framework has to keep.

import { describe, expect, test } from 'bun:test';
import { defineConfig } from '@ultimat3/core';
import { CURRENCY_CODE_PATTERN, isCurrencyCode } from '@ultimat3/schema';

/**
 * What core's copy says about one code, read through the only thing it gates: `defineConfig`.
 *
 * A rejection counts only when the *currency* is what core objected to. `validate()` collects
 * every issue and joins them with `; `, so a cause naming anything else means this fixture stopped
 * isolating the field — and a comparison that read a `defaultLocale` failure as a currency verdict
 * would pass for the wrong reason, which is worse than not testing it at all.
 */
function coreAccepts(code: string): boolean {
  try {
    defineConfig({ name: 'currency-pin', defaultCurrency: code });
    return true;
  } catch (error) {
    const cause = (error as { readonly cause?: unknown }).cause;
    if (
      typeof cause === 'string' &&
      cause.includes('is not a 3-letter ISO 4217 code') &&
      !cause.includes('; ')
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * `'USD\n'` is the first entry and the one that earns the file: `$` is end-of-input in ECMAScript
 * and in a Postgres `~`, and end-of-LINE under a multiline flag — so a `/m` slipped into either
 * copy accepts a currency the other refuses, and the first thing that notices is a `char(3)` CHECK
 * on a real server. The rest are the ordinary ways a code is nearly right.
 */
const CORPUS: readonly string[] = [
  'USD\n',
  '\nUSD',
  'usd',
  'US ',
  ' US',
  '',
  'USDD',
  'US1',
  'USD',
  'EUR',
  'GHS',
];

describe('core and schema agree about what an ISO 4217 code is', () => {
  test('every code in the corpus is accepted by both or refused by both, never split', () => {
    for (const code of CORPUS) {
      expect({ code, core: coreAccepts(code) }).toEqual({
        code,
        core: isCurrencyCode(code),
      });
    }
  });

  test('the corpus is discriminating: it holds both verdicts, so agreement means something', () => {
    // Two constants that both refuse everything would "agree" on a corpus of near-misses alone.
    expect(CORPUS.some((code) => isCurrencyCode(code))).toBe(true);
    expect(CORPUS.some((code) => !isCurrencyCode(code))).toBe(true);
  });

  test('the pattern stays inside the syntax all three dialects spell identically', () => {
    // The bound the doc block states, made checkable: anchors, a literal class, a bounded
    // repetition — and no flags, which is what `'USD\n'` above is really about.
    expect(CURRENCY_CODE_PATTERN).toBe('^[A-Z]{3}$');
  });
});
