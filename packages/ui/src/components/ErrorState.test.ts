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
        // No command: `x logs` is planned and exits X_NOT_IMPLEMENTED, and nothing shipped can
        // name a throw site the framework never saw typed. The fix is the throw-site edit.
        expect(parts?.fix).toContain('throw an UltimateError subclass');
        expect(parts?.fix).not.toContain('x logs');
        expect(parts?.cause.length).toBeGreaterThan(0);
      });
    }
  });
});
