// Row h: `x db reset` deleted `.x/pgdata` from under a running `x dev`, whose embedded Postgres
// still had the directory open. The dev lock is the one fact that says a process holds it.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { dbCommand } from './cmd-db';
import type { CommandContext } from './command';
import { lockPath } from './dev-lock';
import { exec } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';

describe('unit · x db reset never deletes a database a running x dev holds', () => {
  test('a live dev lock refuses the reset with X_DEV_ALREADY_RUNNING, and pgdata survives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-db-reset-lock-'));
    try {
      await Bun.write(join(root, 'app.config.ts'), 'export default {};\n');
      await Bun.write(join(root, '.x/pgdata/PG_VERSION'), '17\n');
      const lock = { pid: process.pid, port: 3000, url: 'http://localhost:3000', startedAt: '' };
      await Bun.write(lockPath(join(root, '.x')), JSON.stringify(lock));
      const ctx: CommandContext = {
        args: parseArgs(['db', 'reset'], SPECS),
        cwd: root,
        runner: exec,
        env: {},
        bunVersion: REQUIRED_BUN,
      };

      const refused = await dbCommand.run(ctx).then(
        () => expect.unreachable('reset ran under a live x dev'),
        (error: unknown) => error as { code: string },
      );

      expect(refused.code).toBe('X_DEV_ALREADY_RUNNING');
      expect(await Bun.file(join(root, '.x/pgdata/PG_VERSION')).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// PGlite takes no lock of its own. Measured: a second process opens a directory `x dev` holds,
// its `create table` succeeds, and the holder's next write replaces the catalog — the table the
// migration created is gone, with no error on either side.
describe('unit · x db migrate never applies into an embedded database a running x dev holds', () => {
  // Port 1 answers nothing: a holder with no web role, or one whose listener is gone. The pass is
  // asked of the holder first (`cmd-db-migrate-dev.test.ts`); unanswered, it is never applied here.
  test('a holder that does not answer refuses the migrate, before pgdata is opened', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-db-migrate-lock-'));
    try {
      await Bun.write(join(root, 'app.config.ts'), "export const config = { name: 'held' };\n");
      const lock = { pid: process.pid, port: 1, url: 'http://localhost:1', startedAt: '' };
      await Bun.write(lockPath(join(root, '.x')), JSON.stringify(lock));
      const ctx: CommandContext = {
        args: parseArgs(['db', 'migrate'], SPECS),
        cwd: root,
        runner: exec,
        env: {},
        bunVersion: REQUIRED_BUN,
      };

      const result = await dbCommand.run(ctx);

      expect(result.ok).toBe(false);
      expect(result.findings?.map((finding) => finding.code)).toEqual(['X_DEV_ALREADY_RUNNING']);
      expect(result.findings?.[0]?.fix).toStartWith('x stop --json && x db migrate && x dev');
      expect(await Bun.file(join(root, '.x/pgdata/PG_VERSION')).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
