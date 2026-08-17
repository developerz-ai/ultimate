// unit — which store the app writes to, per environment. The failure case comes first: a deploy
// with no DATABASE_URL used to get the in-memory driver and say nothing, which is what put four
// disconnected copies of the world behind one public URL.
//
// `reset` is the discriminator, and it is the framework's own: `memoryDriver()` implements the test
// seam, `postgresDriver()` deliberately leaves it undefined (packages/entity/src/database.ts:20).

import { expect, test } from 'bun:test';
import { selectDriver } from './client';

const PG = 'postgres://demo:demo@db:5432/social-media-clone';

test('production with no DATABASE_URL is refused, not quietly served from memory', () => {
  let caught: unknown;
  try {
    selectDriver({ NODE_ENV: 'production' });
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({
    code: 'X_ENV_MISSING',
    // Executable: the operator can act on this without reading a file.
    fix: expect.stringContaining('set DATABASE_URL to the Postgres url'),
  });
});

test('staging is refused too — staging exists to fail the way production fails', () => {
  expect(() => selectDriver({ ULTIMATE_ENV: 'staging' })).toThrow('X_ENV_MISSING');
});

test('DATABASE_URL selects the Postgres driver, in every environment', () => {
  for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: 'test' }, {}]) {
    expect(selectDriver({ ...env, DATABASE_URL: PG }).reset).toBeUndefined();
  }
});

test('an empty DATABASE_URL is unset — .env.development ships exactly that', () => {
  expect(typeof selectDriver({ NODE_ENV: 'test', DATABASE_URL: '' }).reset).toBe('function');
});

test('development and test keep the embedded store, so a fresh clone boots with no database', () => {
  expect(typeof selectDriver({ NODE_ENV: 'development' }).reset).toBe('function');
  expect(typeof selectDriver({}).reset).toBe('function');
});
