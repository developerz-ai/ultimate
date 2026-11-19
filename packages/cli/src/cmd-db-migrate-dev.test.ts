// `x db migrate` beside a live `x dev` on the embedded database, end to end: the pass is applied
// by the dev server that holds `.x/pgdata`, so the fix `x dev` itself prints (`x db gen … && x db
// migrate`) works without stopping it — and no second process opens the directory. Until it is
// applied the server is not green (`X_APP_MIGRATIONS_UNAPPLIED`); `x db rollback` takes the same door.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { dbCommand } from './cmd-db';
import { BOOT_TIMEOUT_MS, bootDevFixture } from './cmd-dev-boot-fixture';
import type { CommandContext } from './command';
import { clearLock, lockPath } from './dev-lock';
import { exec } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const dev = bootDevFixture('.dev-migrate-fixture');

const ctxFor = (argv: readonly string[]): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd: dev.root,
  runner: exec,
  env: {},
  bunVersion: REQUIRED_BUN,
});

const UNAPPLIED = 'X_APP_MIGRATIONS_UNAPPLIED';
const codes = (): readonly string[] => dev.server.findings.map((finding) => finding.code);
const unapplied = (): boolean => dev.server.findings.some((finding) => finding.code === UNAPPLIED);

/**
 * A generation is file reads and a bundle, so it settles on I/O: awaited one event-loop turn at a
 * time, never on a wall-clock sleep. One that never holds is a red verdict naming what did not.
 */
async function untilGeneration(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (!done() && performance.now() < deadline) {
    await new Promise<void>((turn) => setImmediate(turn));
  }
  if (!done()) expect.unreachable(`x dev never reported it: ${what}`);
}

afterAll(() => clearLock(join(dev.root, '.x')));

const GADGETS_SQL =
  'create table gadgets (id uuid primary key, label text not null);\n-- down\ndrop table gadgets;\n';
const writeGadgets = (): Promise<number> =>
  Bun.write(join(dev.root, 'packages/db/migrations/0001_gadgets.sql'), GADGETS_SQL);

/** What `cmd-dev.ts` writes once the server reports its address; `startDev` alone does not. */
async function writeDevLock(): Promise<void> {
  const { server } = dev;
  const lock = { pid: process.pid, port: Number(new URL(server.url).port), url: server.url };
  await Bun.write(lockPath(server.services.stateDir), JSON.stringify({ ...lock, startedAt: '' }));
}

describe('unit · x db migrate beside a live embedded x dev', () => {
  test(
    'the running dev server applies the pass, and its own database holds the table',
    async () => {
      const { server } = dev;
      await writeGadgets();
      // `x db gen` beside a running dev leaves exactly this: a file the database has not applied.
      // The watcher's generation says so, where the banner used to stay green over a 500.
      await untilGeneration(unapplied, 'a migration on disk the ledger lacks');
      const behind = server.findings.find((finding) => finding.code === UNAPPLIED);
      expect(behind?.cause).toContain('0001_gadgets');
      expect(behind?.fix).toBe('x db migrate');
      // A ledger behind its files is no reason for a new process: this one applies the pass, and a
      // restart here is the dead port `x db migrate` then dialled (measured, two processes).
      expect(codes()).not.toContain('X_DEV_RESTART_REQUIRED');
      await writeDevLock();

      const result = await dbCommand.run(ctxFor(['db', 'migrate']));

      // The hand-written file carries no snapshot, and the holder's drift report says so: the
      // post-condition crosses the door with the apply, as `runMigrations` returns both.
      expect(result.findings?.map((finding) => finding.code)).toEqual(['X_DB_DRIFT']);
      expect(result.findings?.[0]?.cause).toContain('records no schema snapshot');
      expect((result.data as { applied: string[] }).applied).toEqual(['0001_gadgets']);
      const read = (await (await dev.runSql('select count(*)::int as n from gadgets')).json()) as {
        data: { result: { rows: unknown[][] } | null };
      };
      expect(read.data.result?.rows).toEqual([[0]]);
      // No file moved, so no watcher tick: the pass itself asks for the generation that clears it.
      await untilGeneration(() => !unapplied(), 'the ledger caught up with the migrations');
      // Nor is the finding clearing: the request that was a 500 is answered by the same process.
      expect(codes()).not.toContain('X_DEV_RESTART_REQUIRED');
    },
    BOOT_TIMEOUT_MS,
  );

  test(
    'x db rollback is run by the same dev server, and the migration is pending again',
    async () => {
      // Its own setup, so `-t` runs it alone: applied by the holder (a no-op after the test above).
      await writeGadgets();
      await writeDevLock();
      await dbCommand.run(ctxFor(['db', 'migrate']));
      await untilGeneration(() => !unapplied(), 'the migration applied before its rollback');

      const result = await dbCommand.run(ctxFor(['db', 'rollback']));

      expect(result.findings ?? []).toEqual([]);
      expect((result.data as { reverted: string[] }).reverted).toEqual(['0001_gadgets']);
      // The holder's own database lost the table: its `down` ran there, not in a second opener.
      const read = (await (await dev.runSql("select to_regclass('gadgets') as t")).json()) as {
        data: { result: { rows: unknown[][] } | null };
      };
      expect(read.data.result?.rows).toEqual([[null]]);
      await untilGeneration(unapplied, 'the reversed migration is on disk and unapplied');

      // Applied again with the schema dump already on disk: this pass writes no file, so only the
      // door's own request for a generation can clear the finding.
      const again = await dbCommand.run(ctxFor(['db', 'migrate']));
      expect((again.data as { applied: string[] }).applied).toEqual(['0001_gadgets']);
      await untilGeneration(() => !unapplied(), 'the re-applied migration');
    },
    BOOT_TIMEOUT_MS,
  );

  test('the rollback door refuses a step count the flag would refuse', async () => {
    const response = await dev.fetchDev('/_x/db/rollback?steps=-1', { method: 'POST' });
    const body = (await response.json()) as { ok: boolean; error?: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('X_CLI_BAD_FLAG');
  });

  test('a cross-site page cannot ask for the pass', async () => {
    const response = await dev.fetchDev('/_x/db/migrate', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(response.status).toBe(403);
  });
});
