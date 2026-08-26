// Owns the identifier grammar and, above all, the SUGGESTION its two refusals hand back: a `fix:`
// is an instruction (axiom 4), so a replacement the grammar itself rejects is a refusal that
// cannot be acted on. Beside `metrics.test.ts` rather than inside it — that file drives the
// instrument registry, and this one asks only what a name is allowed to be.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, type UltimateError } from './errors';
import { assertLabelNames, assertMetricName, METRIC_NAME_RE } from './metric-names';

const refusal = (fn: () => void): UltimateError => {
  try {
    fn();
  } catch (thrown) {
    if (isUltimateError(thrown)) return thrown;
    return expect.unreachable('expected an UltimateError');
  }
  return expect.unreachable('expected a refusal, nothing was thrown');
};

/** The identifier after `e.g. `, with or without the label form's surrounding braces. */
const suggested = (fix: string): string => {
  const found = /e\.g\. \{? ?([^\s:{}]+)/.exec(fix);
  return found?.[1] ?? expect.unreachable(`no suggestion in the fix line: ${fix}`);
};

describe('the suggestion in a fix line satisfies the grammar that line cites', () => {
  /**
   * Lowercasing `2digits` leaves `2digits`, and `METRIC_NAME_RE` demands a leading `[a-z_]` — so
   * the refusal told the caller to rename the instrument to the name it had just refused, and a
   * caller who pasted it got the identical error a second time. An error that cannot be acted on
   * is the defect axiom 4 exists for, whatever its cause line says.
   */
  test('a digit-leading instrument name is given a suggestion that is declarable', () => {
    const name = suggested(refusal(() => assertMetricName('2digits')).fix);
    expect(METRIC_NAME_RE.test(name)).toBe(true);
    // The whole point: pasting it works, rather than raising the same refusal a second time.
    expect(() => assertMetricName(name)).not.toThrow();
    expect(name).toBe('_2digits');
  });

  test('a digit-leading label name had the same defect and is repaired the same way', () => {
    const label = suggested(
      refusal(() => assertLabelNames('orders_total', { '2digits': 'x' })).fix,
    );
    expect(METRIC_NAME_RE.test(label)).toBe(true);
    expect(() => assertLabelNames('orders_total', { [label]: 'x' })).not.toThrow();
  });

  test('every character class the grammar refuses still normalises to something declarable', () => {
    for (const bad of ['HTTP.Requests', 'bad"key', 'route,status', 'with space', 'line\nbreak']) {
      const name = suggested(refusal(() => assertMetricName(bad)).fix);
      expect(METRIC_NAME_RE.test(name)).toBe(true);
    }
  });

  test('a name lowercasing alone repairs is left alone — the prefix is not unconditional', () => {
    expect(suggested(refusal(() => assertMetricName('HTTP.Requests')).fix)).toBe('http_requests');
  });
});

describe('the grammar itself', () => {
  test('accepts what every exposition format accepts, and nothing else', () => {
    for (const name of ['http_requests_total', '_private', 'a', 'queue_depth9']) {
      expect(() => assertMetricName(name)).not.toThrow();
    }
    for (const name of ['', '9lives', 'Upper', 'has-dash', 'has.dot']) {
      expect(refusal(() => assertMetricName(name)).code).toBe('X_METRIC_NAME_INVALID');
    }
  });

  test('a label set with nothing wrong in it passes silently', () => {
    expect(() =>
      assertLabelNames('http_requests_total', { route: '/posts', http_status: 200 }),
    ).not.toThrow();
  });
});
