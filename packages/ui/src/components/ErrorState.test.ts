// `errorParts` is the renderer-free half of `<ErrorState>` — the only part of the component a test
// can reach without a Solid runtime, and the only part that touches a value the app controls.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { errorParts } from './ErrorState';

describe('errorParts', () => {
  test('an UltimateError is passed through verbatim, never paraphrased', () => {
    const error = new UltimateError({
      code: 'X_ID_INVALID',
      cause: 'not a uuid',
      fix: 'parseId()',
    });
    expect(errorParts(error)).toEqual({
      code: 'X_ID_INVALID',
      title: error.title,
      cause: 'not a uuid',
      fix: 'parseId()',
      docs: error.docs,
    });
  });

  test('an ordinary Error keeps its message as the cause', () => {
    expect(errorParts(new TypeError('x is not a function')).cause).toBe('x is not a function');
  });

  // This component is what a screen renders INSTEAD of the thing that failed, so a throw while
  // building its text is a blank tree where the report was. `String(error)` runs the value's own
  // `toString`, and the value is whatever the app threw.
  describe('a thrown value it cannot control', () => {
    const hostile = (): ReadonlyMap<string, unknown> =>
      new Map<string, unknown>([
        [
          'a hostile toString',
          {
            toString: () => {
              throw new Error('gotcha');
            },
          },
        ],
        ['a null-prototype object', Object.create(null)],
        ['a symbol', Symbol('boom')],
      ]);

    for (const [label, value] of hostile()) {
      test(`still renders X_INTERNAL for ${label}`, () => {
        let parts: ReturnType<typeof errorParts> | undefined;
        expect(() => {
          parts = errorParts(value);
        }).not.toThrow();
        expect(parts?.code).toBe('X_INTERNAL');
        expect(parts?.fix).toBe('x logs --json | tail -50');
        expect(parts?.cause.length).toBeGreaterThan(0);
      });
    }
  });
});
