// `x db backfill`'s four shapes, driven through `createMemoryDriver()` — which sweeps are
// pending, what a dry run plans, what `--write` enqueues and what the ledger reports. Split from
// `cmd-db.test.ts` with the wiring it drives (`cmd-db-backfill.ts`): that file crossed the
// 500-line ceiling, and "does this command run one engine" and "what does a sweep pass report"
// are two questions.

import { afterEach, describe, expect, test } from 'bun:test';
// why: `node:fs`/`node:os` — Bun has no temp-directory API; `node:path` — no Bun path joiner.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { entity, memoryRepo, tableFor, uuid } from '@ultimat3/entity';
import type { JobDriver } from '@ultimat3/jobs';
import {
  backfill,
  createMemoryDriver,
  resetJobDriver,
  resetJobs,
  setJobDriver,
} from '@ultimat3/jobs';
import { DB_SUBCOMMANDS, dbCommand } from './cmd-db';
import type { CommandContext } from './command';
import { BadFlagError } from './errors';
import { exec } from './exec';
import { msg } from './messages';
import type { CommandResult } from './output';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const ctxFor = (argv: readonly string[], cwd: string): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  runner: exec,
  env: {},
  bunVersion: '1.3.0',
});

/** An app root the command will accept: `app.config.ts` is what `requireAppRoot` looks for. */
async function appRoot(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'x-db-backfill-'));
  await Bun.write(join(dir, 'app.config.ts'), 'export const config = {};\n');
  return dir;
}

/** Install the driver `withJobDriver` must reuse, so no test here boots a queue or a database. */
async function runBackfill(driver: JobDriver, argv: readonly string[]): Promise<CommandResult> {
  setJobDriver(driver);
  const root = await appRoot();
  try {
    return await dbCommand.run(ctxFor(argv, root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

interface SweepRow {
  readonly id: string;
  readonly orgId: string;
}

/**
 * `entity()` registers globally, so it is built inside `source` — a body no test here calls.
 * Registered at module scope it would make `x db gen`'s "an unchanged schema generates nothing"
 * emit a migration for a table only this file knows about.
 */
const declareSweep = (name: string) =>
  backfill<SweepRow>({
    name,
    // These fixtures assert `x db backfill`'s PLAN — which sweeps are pending, what a dry run
    // enqueues — and never run a pass, so nothing here is ever scoped.
    tenant: 'none',
    source: () => {
      const rows = entity(`cmd_db_${name.replaceAll('-', '_')}`, {
        columns: { id: uuid().primaryKey(), orgId: uuid() },
      });
      return tableFor(rows, memoryRepo(rows, []));
    },
    handle: () => undefined,
  });

/** One name's row out of `x db backfill`'s `--json`, whatever else the process declared. */
const planFor = (result: CommandResult, name: string): { readonly action: string } | undefined =>
  (result.data as readonly { readonly name: string; readonly action: string }[]).find(
    (row) => row.name === name,
  );

const queuedCount = async (driver: JobDriver): Promise<number> =>
  (await driver.stats()).reduce((total, stats) => total + stats.ready + stats.delayed, 0);

async function seedPass(driver: JobDriver, runId: string, name: string): Promise<void> {
  await driver.backfills?.start({ runId, name, checksum: 'abc123', appVersion: '1.2.0' });
  await driver.backfills?.progress(runId, { rows: 250, cursor: 'post_250' });
}

afterEach(() => {
  // `resetJobDriver()` alone leaves the DECLARATIONS behind: `backfill()` registers into a
  // process-wide registry that every suite in this run shares, so a sweep declared here would
  // still be pending for whichever file goes next — and a rerun of one of these tests would hit
  // X_JOB_DUPLICATE on its own name.
  resetJobs();
  resetJobDriver();
});

describe('unit · x db backfill', () => {
  test('every flag the four shapes need is declared, so the parser reaches them', () => {
    expect(DB_SUBCOMMANDS).toContain('backfill');
    const flags = dbCommand.spec.flags?.map((flag) => flag.name) ?? [];
    for (const flag of ['list', 'status', 'limit', 'pending', 'all', 'write', 'force']) {
      expect(flags).toContain(flag);
    }
    // `--name` already meant "migration or branch"; one declaration, widened, never a second.
    expect(flags.filter((flag) => flag === 'name')).toHaveLength(1);
  });

  test('a bare x db backfill refuses and names a shape that works', async () => {
    const driver = createMemoryDriver();
    const thrown: unknown = await runBackfill(driver, ['db', 'backfill']).then(
      () => undefined,
      (error: unknown) => error,
    );
    // Not X_NOT_IMPLEMENTED: this subcommand ships four shapes. Not a silent default to one of
    // them either — they answer four different questions, and picking one is the ambiguity axiom
    // 1 refuses.
    expect(thrown).toBeInstanceOf(BadFlagError);
    expect((thrown as BadFlagError).fix).toBe('x db backfill --pending --json');
    expect((thrown as BadFlagError).cause).toContain('--pending');
  });

  // Precedence, measured before this landed: `--all` won and every pending sweep was enqueued
  // while the operator had NAMED one. `--list --pending` reported the ledger for a question about
  // what is unswept. Both ran, neither said anything, and one of them writes.
  test.each([
    [['db', 'backfill', 'cleanup', '--all', '--write'], 'cleanup'],
    [['db', 'backfill', '--list', '--pending'], '--pending'],
    [['db', 'backfill', '--pending', '--all'], '--all'],
    [['db', 'backfill', '--pending', 'cleanup'], 'cleanup'],
    // The one shape that DROPPED it instead of refusing: `--list` forces the target to undefined,
    // so `x db backfill cleanup --list` listed the whole ledger and reported ok while the operator
    // had named one sweep — the same argv one flag over has always been refused.
    [['db', 'backfill', 'cleanup', '--list'], 'cleanup'],
  ])('%o asks two questions, so it is refused rather than resolved', async (argv, second) => {
    const driver = createMemoryDriver();
    const thrown: unknown = await runBackfill(driver, argv).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(BadFlagError);
    expect((thrown as BadFlagError).cause).toContain(second);
    expect((thrown as BadFlagError).fix).toStartWith('x db backfill ');
    expect(await queuedCount(driver)).toBe(0);
  });

  // A filter for a shape that has none is not "ignored", it is a different command than the one
  // the caller typed: `--status` narrows the ledger and a PASS has no ledger to narrow.
  test.each([
    [
      ['db', 'backfill', '--pending', '--status', 'failed'],
      'status',
      'x db backfill --list --json',
    ],
    [['db', 'backfill', '--all', '--limit', '5'], 'limit', 'x db backfill --list --json'],
    [['db', 'backfill', '--list', '--write'], 'write', 'x db backfill --all --write --json'],
  ])('%o carries a flag its shape cannot read', async (argv, flag, fix) => {
    const thrown: unknown = await runBackfill(createMemoryDriver(), argv).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(BadFlagError);
    expect((thrown as BadFlagError).cause).toStartWith(`--${flag} on "x db"`);
    expect((thrown as BadFlagError).fix).toBe(fix);
  });

  // `--name` keeps both meanings, and each is still reachable: a filter under `--list`, a target
  // without it. Two spellings of the target in one argv is the ambiguity, not the flag itself.
  test('--name filters the ledger under --list, and names the pass without it', async () => {
    const listed = await runBackfill(createMemoryDriver(), [
      'db',
      'backfill',
      '--list',
      '--name',
      'cmd-db-filtered',
    ]);
    expect(listed.ok).toBe(true);

    const thrown: unknown = await runBackfill(createMemoryDriver(), [
      'db',
      'backfill',
      'cleanup',
      '--name',
      'other',
    ]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(BadFlagError);
    expect((thrown as BadFlagError).cause).toContain('other');
  });

  // The instructive half of the refusal above: the fix hands back the SAME question in the one
  // spelling `--list` reads, so the reader retypes nothing.
  test('a positional under --list is answered with the --name form of the same question', async () => {
    const thrown: unknown = await runBackfill(createMemoryDriver(), [
      'db',
      'backfill',
      'cleanup',
      '--list',
    ]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((thrown as BadFlagError).fix).toBe('x db backfill --list --name cleanup --json');
  });

  test('--pending names a declared sweep the ledger has never recorded, and exits non-zero', async () => {
    // Declared in the test body, never at module scope: the jobs registry is process-wide and
    // this file shares it with every other suite in the run.
    declareSweep('cmd-db-never-run');
    const result = await runBackfill(createMemoryDriver(), ['db', 'backfill', '--pending']);

    // The exit code is the whole point: a cron reads it without parsing the table.
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.code)).toContain('X_BACKFILL_PENDING');
    expect(result.data).toMatchObject({ environment: 'development' });
    expect((result.data as { pending: readonly string[] }).pending).toContain('cmd-db-never-run');
    expect(result.summary).not.toContain('⟦');
  });

  test('a name no declaration carries is X_BACKFILL_UNKNOWN, and writes nothing', async () => {
    const result = await runBackfill(createMemoryDriver(), ['db', 'backfill', 'never-declared']);
    expect(result.ok).toBe(false);
    expect(result.findings?.[0]?.code).toBe('X_BACKFILL_UNKNOWN');
    expect(result.findings?.[0]?.fix).toContain('x db backfill --pending');
    expect(result.data).toMatchObject([{ name: 'never-declared', action: 'blocked', jobId: null }]);
  });

  test('a dry run plans and writes nothing; --all --write enqueues the pending sweep', async () => {
    declareSweep('cmd-db-all-sweep');
    const driver = createMemoryDriver();

    const dry = await runBackfill(driver, ['db', 'backfill', '--all']);
    expect(planFor(dry, 'cmd-db-all-sweep')?.action).toBe('planned');
    expect(dry.summary).not.toContain('⟦');
    expect(await queuedCount(driver)).toBe(0);

    const written = await runBackfill(driver, ['db', 'backfill', '--all', '--write']);
    expect(planFor(written, 'cmd-db-all-sweep')?.action).toBe('enqueued');
    expect(await queuedCount(driver)).toBeGreaterThan(0);
  });

  test('--list prints the ledger as a table and carries the same rows in data', async () => {
    const driver = createMemoryDriver();
    await seedPass(driver, 'run_1', 'reindex-posts');

    const result = await runBackfill(driver, ['db', 'backfill', '--list']);
    const rendered = (result.lines ?? []).join('\n');

    expect(result.ok).toBe(true);
    expect(result.summary).toBe(msg('cli.db.backfill.listed', { count: 1 }));
    expect(rendered).toContain('started-at');
    expect(rendered).toContain('reindex-posts');
    expect(rendered).toContain('post_250');
    expect(rendered).not.toContain('⟦');
    expect(result.data).toMatchObject([
      { runId: 'run_1', name: 'reindex-posts', status: 'running', rows: 250, cursor: 'post_250' },
    ]);
  });

  test('an empty ledger is ok: nothing has swept this database yet is an answer', async () => {
    const result = await runBackfill(createMemoryDriver(), ['db', 'backfill', '--list']);

    expect(result.ok).toBe(true);
    expect(result.summary).toBe(msg('cli.db.backfill.empty'));
    expect(result.lines).toEqual([]);
    expect(result.data).toEqual([]);
  });

  test('--name and --status filter the ledger the command prints', async () => {
    const driver = createMemoryDriver();
    await seedPass(driver, 'run_1', 'reindex-posts');
    await seedPass(driver, 'run_2', 'recount-likes');

    const named = await runBackfill(driver, [
      'db',
      'backfill',
      '--list',
      '--name',
      'recount-likes',
    ]);
    expect(named.data).toMatchObject([{ runId: 'run_2' }]);

    const done = await runBackfill(driver, ['db', 'backfill', '--list', '--status', 'completed']);
    expect(done.data).toEqual([]);
  });
});
