// The pass hands `rollback()` the database it runs against, so the consent rule for a database on
// another machine is asked of the real binding: `DATABASE_URL=<remote>` with no environment named
// is refused until `ROLLBACK_ALLOW_DESTRUCTIVE` names the id.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: `node:fs` — Bun has no temp-directory API.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { isUltimateError } from '@ultimat3/core';
import { migrate, pgliteClient, ROLLBACK_ALLOW_DESTRUCTIVE_ENV, setDbClient } from '@ultimat3/db';
import { reverseApplied, rollbackPass } from './db-rollback-pass';
import { lockPath } from './dev-lock';
import { MIGRATIONS_DIR, readMigrations } from './migrations';
import { resolveServices } from './runtime-bindings';

const PGLITE_BOOT_MS = 30_000;
const ID = '0001_gizmos';
const REMOTE = 'postgres://app@db.prod.example.com:5432/app';
const root = mkdtempSync(join(tmpdir(), 'x-rollback-pass-'));
const client = pgliteClient();

beforeAll(async () => {
  await Bun.write(
    join(root, MIGRATIONS_DIR, `${ID}.sql`),
    'create table gizmos (id uuid primary key);\n-- down\ndrop table gizmos;\n',
  );
  await migrate({ migrations: await readMigrations(root), client });
  setDbClient(client);
}, PGLITE_BOOT_MS);

afterAll(() => {
  setDbClient(undefined);
  rmSync(root, { recursive: true, force: true });
});

describe('reverseApplied', () => {
  test('a remote DATABASE_URL needs the names even when no environment is set', async () => {
    const refused = await reverseApplied(root, { DATABASE_URL: REMOTE }, 1).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isUltimateError(refused) ? refused.code : refused).toBe(
      'X_MIGRATION_ROLLBACK_DESTRUCTIVE',
    );

    const named = { DATABASE_URL: REMOTE, [ROLLBACK_ALLOW_DESTRUCTIVE_ENV]: ID };
    expect(await reverseApplied(root, named, 1)).toEqual([ID]);
  });
});

// Beside a live `x dev` the pass is a POST. One that may have reached the holder and lost its answer
// may have reversed a migration: its fix reads the ledger, and pasting it never reverses a second.
describe('rollbackPass beside a live x dev', () => {
  const app = mkdtempSync(join(tmpdir(), 'x-rollback-holder-'));
  // This process is the "holder": alive, and a lock with no OS start time is never a reused pid.
  const stamp = { pid: process.pid, port: 3111, url: 'http://localhost:3111' };
  const holding = async (startedAt: string): Promise<void> => {
    await Bun.write(
      lockPath(resolveServices(app, {}).stateDir),
      JSON.stringify({ ...stamp, startedAt }),
    );
  };
  afterAll(() => rmSync(app, { recursive: true, force: true }));

  async function fixOf(post: (url: string) => Promise<unknown>): Promise<string> {
    const error = await rollbackPass(app, {}, 1, post).then(
      () => expect.unreachable('the holder answered'),
      (thrown: unknown) => thrown,
    );
    if (!isUltimateError(error)) return expect.unreachable('an uncoded throw');
    expect(error.code).toBe('X_DEV_ALREADY_RUNNING');
    return error.fix;
  }

  test('sent and unanswered: the fix reads the ledger, never asks for the rollback again', async () => {
    await holding('2020-01-01T00:00:00.000Z');
    const lost = await fixOf(() => Promise.reject(new TypeError('socket closed')));
    expect(lost).toStartWith('x stop --json && x db status && x dev');
    expect(lost).not.toContain('rollback --steps');
    // Answered `ok` but unreadable: the holder ran it, so the same read, never a repeat.
    const odd = await fixOf(async () => ({ ok: true, data: { reverted: 'all' } }));
    expect(odd).toStartWith('x stop --json && x db status && x dev');
  });

  test('never sent (refused connection, or no such route): repeating it is the fix', async () => {
    await holding('2020-01-01T00:00:00.000Z');
    const refused = Object.assign(new TypeError('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(await fixOf(() => Promise.reject(refused))).toStartWith(
      'x stop --json && x db rollback --steps 1 && x dev',
    );
    expect(await fixOf(async () => ({ panel: '/_x' }))).toStartWith(
      'x stop --json && x db rollback --steps 1 && x dev',
    );
  });
});
