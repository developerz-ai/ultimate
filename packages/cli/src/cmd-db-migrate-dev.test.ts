// `x db migrate` beside a live `x dev` on the embedded database, end to end: the pass is applied
// by the dev server that holds `.x/pgdata`, so the fix `x dev` itself prints (`x db gen … && x db
// migrate`) works without stopping it — and no second process opens the directory. Until it is
// applied the server is not green (`X_APP_MIGRATIONS_UNAPPLIED`); `x db rollback` takes the same door.
//
// Order-independence (flake-hunt issue #1285, run 44716847232, suite unit, round 3, seed 86845165):
// the one fixture boots once per file, so the stateful tests share a database, a ledger and a
// `0001_gadgets.sql`. The rollback test used to end with that migration applied, assuming it ran
// after the migrate test; under `--randomize` it ran first, so the migrate test's precondition
// ("a migration on disk the ledger lacks") never arose and `untilGeneration` timed out (lines 41
// and 66 of the original file). Only unit round 3 failed; unit rounds 1/2 and every live round
// passed. The exact shuffled per-test order from the round-3 uploaded artifact is UNAVAILABLE; that
// gap is why the fix establishes the precondition locally instead of relying on an observed order.

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

/** How often a generation is asked for. The clock is `performance.now()`, not the frozen `Date`. */
const GENERATION_POLL_MS = 25;

/**
 * One wait's share of a test's budget. The longest test here waits three times, so even three waits
 * that each run out stay inside `BOOT_TIMEOUT_MS`: the verdict is always the named
 * `expect.unreachable` below, never bun killing the test at its own deadline.
 */
const GENERATION_WAIT_MS = BOOT_TIMEOUT_MS / 8;

/**
 * A generation is file reads and a bundle in the dev server's own process, so it settles on another
 * process's I/O — hence the real turn between polls, marked as such: four waiting workers spinning
 * `setImmediate` each burn a core polling I/O that needs the CPU they took. The bound is a share of
 * `BOOT_TIMEOUT_MS` — the budget these tests are given — so one that never settles reports the red
 * verdict naming what did not, instead of bun's bare timeout with no reason attached.
 */
async function untilGeneration(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + GENERATION_WAIT_MS;
  while (!done() && performance.now() < deadline) {
    await Bun.sleep(GENERATION_POLL_MS); // real-clock: the rebuild is the dev server's own work
  }
  if (!done()) expect.unreachable(`x dev never reported it: ${what}`);
}

afterAll(() => clearLock(join(dev.root, '.x')));

const GADGETS_SQL =
  'create table gadgets (id uuid primary key, label text not null);\n-- down\ndrop table gadgets;\n';
const writeGadgets = (): Promise<number> =>
  Bun.write(join(dev.root, 'packages/db/migrations/0001_gadgets.sql'), GADGETS_SQL);

const GADGETS_ID = '0001_gadgets';

interface LedgerEntry {
  readonly id: string;
  readonly checksum: string;
}

/** The ledger through the holder's own read door: the ids whose SQL has been applied. */
async function appliedIds(): Promise<readonly string[]> {
  const response = await dev.fetchDev('/_x/db/ledger', { method: 'POST' });
  const body = (await response.json()) as {
    ok: boolean;
    data?: { ledger?: readonly LedgerEntry[] };
    error?: { code: string; cause: string; fix: string };
  };
  if (!body.ok) expect.unreachable(`ledger read failed: ${body.error?.code ?? 'unknown'}`);
  return (body.data?.ledger ?? []).map((row) => row.id);
}

/** A SQL statement through the holder, with a verdict: no silent failure on setup. */
async function sqlOk(sql: string): Promise<void> {
  const response = await dev.runSql(sql);
  const body = (await response.json()) as { data?: { result?: unknown } };
  if (body.data?.result === undefined) expect.unreachable(`setup SQL failed: ${sql}`);
}

/**
 * Bring the shared fixture to the flake's exact precondition, whatever ran before this test:
 * the SQL on disk, no `0001_gadgets` row in the ledger, and no `gadgets` table. Every step uses
 * the holder's own `/_x/db` doors, so no second process opens `.x/pgdata`.
 */
async function resetToUnapplied(): Promise<void> {
  await writeDevLock();
  if ((await appliedIds()).includes(GADGETS_ID)) {
    // The rollback's `down` drops the table; make sure it exists even after a failed pass.
    await sqlOk('create table if not exists gadgets (id uuid primary key, label text not null)');
    const reverted = await dbCommand.run(ctxFor(['db', 'rollback', '--steps', '1']));
    expect((reverted.data as { reverted: string[] }).reverted).toEqual([GADGETS_ID]);
  }
  await sqlOk('drop table if exists gadgets');
  await writeGadgets();

  // Fast-failing precondition: name a wrong ledger state here, not after a generation wait runs out.
  expect(await appliedIds()).not.toContain(GADGETS_ID);
  await untilGeneration(unapplied, 'a migration on disk the ledger lacks');
}

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
      await resetToUnapplied();
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
      await resetToUnapplied();
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

  test(
    'the shared fixture resets to a migration the ledger lacks, whatever ran first',
    async () => {
      // Seed the poison state that used to leak across randomized order: the migration APPLIED.
      await writeDevLock();
      await writeGadgets();
      await dbCommand.run(ctxFor(['db', 'migrate']));
      await untilGeneration(() => !unapplied(), 'the migration applied for the reset check');
      expect(await appliedIds()).toContain(GADGETS_ID);

      await resetToUnapplied();

      // The flake's precondition, asserted directly: on disk, absent from the ledger.
      expect(await appliedIds()).not.toContain(GADGETS_ID);
      expect(unapplied()).toBe(true);
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
