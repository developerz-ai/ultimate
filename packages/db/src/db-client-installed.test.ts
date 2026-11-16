// `dbClientInstalled()` answers whether a test installed a client, and asking never builds one:
// a unit test that only asks must not open a pool from `DATABASE_URL`.
import { afterEach, expect, test } from 'bun:test';
import { ambientClient, baseClient, dbClientInstalled, setDbClient } from './client';
import { recordingClient } from './fake';

afterEach(() => setDbClient(undefined));

test('false until setDbClient installs one, true while it is, false once cleared', () => {
  expect(dbClientInstalled()).toBe(false);
  setDbClient(recordingClient());
  expect(dbClientInstalled()).toBe(true);
  setDbClient(undefined);
  expect(dbClientInstalled()).toBe(false);
});

test('asking twice builds nothing in between', () => {
  dbClientInstalled();
  expect(dbClientInstalled()).toBe(false);
});

// `ambientClient()`: what `db()` would use right now, installed OR lazily built, and never built by
// asking — the one read a caller that displaces it needs in order to close what it displaced.
test('ambientClient reads the installed client, then the lazy one, and builds neither', async () => {
  expect(ambientClient()).toBeUndefined();
  expect(ambientClient()).toBeUndefined();
  const installed = recordingClient();
  setDbClient(installed);
  expect(ambientClient()).toBe(installed);
  setDbClient(undefined);
  const lazy = baseClient();
  expect(dbClientInstalled()).toBe(false);
  expect(ambientClient()).toBe(lazy);
  if ('close' in lazy && typeof lazy.close === 'function') await lazy.close();
});
