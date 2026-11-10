// What every WRITE answers in every driver is `@ultimat3/testing`'s `entityDriverConformance`, run
// over memory, PGlite, a Postgres server and a `defineDriver` store. Left here: a declaration the
// column builder refuses before any driver is asked.

import { describe, expect, test } from 'bun:test';
import { text } from './columns';

describe('k — a bound no column can hold', () => {
  test.each([2.5, Number.NaN, 0, -1])(
    'text({ max: %p }) is refused where it is declared',
    (max) => {
      expect(() => text({ max })).toThrow();
    },
  );
});
