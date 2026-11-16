// The textarea's one numeric prop: `rows` lands on an attribute, and `??` does not fire on NaN,
// so a non-finite count rendered `rows="NaN"` and the browser silently drew its own default.

import '../theme/ambient';
import { describe, expect, test } from 'bun:test';
import { byTag, one, renderNodes } from '@ultimat3/core/render-nodes';
import { Textarea } from './Textarea';

const textarea = (extra: Record<string, unknown> = {}) =>
  one(byTag(renderNodes(Textarea, { name: 'body', ...extra }), 'textarea'), '<textarea>');

describe('Textarea rows', () => {
  test('absent, it is 3', () => {
    expect(textarea().props['rows']).toBe(3);
  });

  test('declared, it is the declared count', () => {
    expect(textarea({ rows: 8 }).props['rows']).toBe(8);
  });

  for (const rows of [Number.NaN, Number.NEGATIVE_INFINITY]) {
    test(`rows: ${String(rows)} is refused, never rendered`, () => {
      expect(() => textarea({ rows })).toThrow(/X_INVARIANT/);
    });
  }
});
