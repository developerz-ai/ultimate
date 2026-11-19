// The CLI's half of `x db migrate` beside a live `x dev`: what the holder answered, read; and
// every answer that is not the route's becomes the refusal whose fix needs no holder.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { migrateThroughDev } from './db-migrate-through-dev';
import type { DevLock } from './dev-lock';

const lock: DevLock = { pid: 4242, port: 3111, url: 'https://0.0.0.0:3111', startedAt: '' };

const DATA = {
  applied: ['0001_gadgets'],
  skipped: 2,
  appVersion: 'dev',
  durationMs: 12,
  drift: [],
  catalog: { schema: 'public', tables: [] },
  storage: [],
};

async function refusal(run: Promise<unknown>): Promise<{ code: string; fix: string }> {
  const error = await run.then(
    () => expect.unreachable('the pass was answered'),
    (thrown: unknown) => thrown,
  );
  if (!isUltimateError(error)) return expect.unreachable('an uncoded throw');
  return { code: error.code, fix: error.fix };
}

describe('migrateThroughDev', () => {
  test('posts to the holder through loopback, on the scheme it serves', async () => {
    const asked: string[] = [];
    const data = await migrateThroughDev(lock, '/app/.x', async (url) => {
      asked.push(url);
      return { ok: true, data: DATA };
    });
    expect(asked).toEqual(['https://localhost:3111/_x/db/migrate']);
    expect(data.applied).toEqual(['0001_gadgets']);
    expect(data.skipped).toBe(2);
  });

  test("the holder's own refusal is re-thrown under its code, cause and fix", async () => {
    const error = { code: 'X_MIGRATION_FAILED', cause: 'syntax error', fix: 'x db gen "repair"' };
    expect(
      await refusal(migrateThroughDev(lock, '/app/.x', async () => ({ ok: false, error }))),
    ).toEqual({ code: 'X_MIGRATION_FAILED', fix: 'x db gen "repair"' });
  });

  test.each([
    ['a closed port', () => Promise.reject(new TypeError('ConnectionRefused'))],
    ['an older server with no such route', async () => ({ panel: '/_x/db/migrate' })],
    ['an answer that is not the pass', async () => ({ ok: true, data: { applied: 'all' } })],
    ['a refusal with no error', async () => ({ ok: false })],
  ])('%s refuses with the stop, migrate, start that needs no holder', async (_name, post) => {
    expect(await refusal(migrateThroughDev(lock, '/app/.x', post))).toEqual({
      code: 'X_DEV_ALREADY_RUNNING',
      fix: 'x stop --json && x db migrate && x dev   # the embedded database takes one process at a time; pass the flags you passed',
    });
  });
});
