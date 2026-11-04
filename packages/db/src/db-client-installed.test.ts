// `dbClientInstalled()` answers whether a test installed a client, and asking never builds one:
// a unit test that only asks must not open a pool from `DATABASE_URL`.
import { afterEach, expect, test } from 'bun:test';
import { dbClientInstalled, setDbClient } from './client';
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
