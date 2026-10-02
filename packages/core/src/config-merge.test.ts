// Single responsibility: pins how one section patch is applied — key by key, `undefined` never
// winning — and that a patch which is not an object is carried through, never iterated.

import { describe, expect, test } from 'bun:test';
import { lastSaid, layered, section } from './config-merge';

describe('section', () => {
  const base = { queues: ['default'], concurrency: 8 };

  test('applies a patch key by key, and an explicit undefined never wins', () => {
    expect(section(base, { concurrency: 2, queues: undefined })).toEqual({
      queues: ['default'],
      concurrency: 2,
    });
    expect(section(base, undefined)).toBe(base);
  });

  test.each([[null], ['redis'], [5], [['a']]])(
    'a patch that is %p is carried as written, not iterated',
    (patch) => {
      // `Object.entries(null)` was a native TypeError out of `defineConfig`'s own merge.
      expect(section(base, patch as never)).toBe(patch as never);
    },
  );

  test('a wrong shape survives later layers, so it is still there to be refused', () => {
    expect(layered(base, [null as never, { concurrency: 2 }])).toBeNull();
  });
});

describe('lastSaid', () => {
  test('the last layer that said something wins', () => {
    expect(lastSaid(['en'], [undefined, ['de'], undefined])).toEqual(['de']);
    expect(lastSaid(['en'], [])).toEqual(['en']);
  });
});
