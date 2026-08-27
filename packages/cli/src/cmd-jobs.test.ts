// The command surface of `x jobs`: the spec, the `--to` validation, and what `run()` actually
// renders. Driven through an ambient `createMemoryDriver()` so `withJobDriver` reuses it instead of
// booting a queue — a real driver, real claim/ack semantics, no database and no app to load.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, and Bun.write is async in these synchronous fixture helpers.
import { mkdtempSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import type { JobDriver } from '@ultimat3/jobs';
import { createMemoryDriver, resetJobDriver, setJobDriver } from '@ultimat3/jobs';
import { REQUIRED_BUN } from './app-root';
import { buildDrainTarget, JOBS_SUBCOMMANDS, jobsCommand } from './cmd-jobs';
import type { CommandContext } from './command';
import { BadFlagError, MissingPositionalError } from './errors';
import { msg } from './messages';
import type { CommandResult } from './output';

interface RunOptions {
  readonly subcommand?: string;
  readonly positionals?: readonly string[];
  readonly flags?: Readonly<Record<string, string | boolean>>;
  readonly env?: Readonly<Record<string, string>>;
}

function appRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'x-jobs-'));
  writeFileSync(join(dir, 'app.config.ts'), 'export const config = {};\n');
  return dir;
}

const contextFor = (root: string, options: RunOptions): CommandContext => ({
  args: {
    command: 'jobs',
    subcommand: options.subcommand,
    positionals: [...(options.positionals ?? [])],
    flags: new Map(Object.entries(options.flags ?? {})),
    json: false,
    help: false,
    passthrough: [],
  },
  cwd: root,
  runner: () =>
    Promise.resolve({
      command: ['true'],
      code: 0,
      ok: true,
      stdout: '',
      stderr: '',
      durationMs: 0,
    }),
  env: options.env ?? {},
  bunVersion: REQUIRED_BUN,
});

/** Install the driver `withJobDriver` must reuse, so no command under test boots a second queue. */
function runJobs(driver: JobDriver, options: RunOptions = {}): Promise<CommandResult> {
  setJobDriver(driver);
  return jobsCommand.run(contextFor(appRoot(), options));
}

async function enqueue(driver: JobDriver, name: string, runAt?: number): Promise<string> {
  const { id } = await driver.enqueue({
    name,
    queue: 'default',
    input: {},
    idempotencyKey: crypto.randomUUID(),
    maxAttempts: 3,
    ...(runAt === undefined ? {} : { runAt }),
  });
  return id;
}

afterEach(() => {
  resetJobDriver();
});

describe('unit · x jobs spec', () => {
  test('names all five subcommands, ls first, with every documented flag', () => {
    expect(JOBS_SUBCOMMANDS).toEqual(['ls', 'show', 'retry', 'cancel', 'drain']);
    expect(jobsCommand.spec.subcommands).toBe(JOBS_SUBCOMMANDS);
    expect(jobsCommand.spec.name).toBe('jobs');
    expect(jobsCommand.spec.requiresApp).toBe(true);
    expect(jobsCommand.spec.flags?.map((flag) => flag.name).sort()).toEqual(
      ['dry-run', 'from-step', 'limit', 'name', 'queue', 'reason', 'state', 'to'].sort(),
    );
  });
});

describe('unit · x jobs ls rendering', () => {
  test('the row count, the table and the depth summary all come from the catalog', async () => {
    const driver = createMemoryDriver();
    await enqueue(driver, 'send-email');

    const result = await runJobs(driver, { subcommand: 'ls' });

    expect(result.ok).toBe(true);
    expect(result.lines?.[0]).toBe(`  ${msg('cli.jobs.listed', { count: 1 })}`);
    expect(result.lines?.[1]).toContain('run-at-ms');
    expect(result.summary).toContain('1 ready');
  });

  test('dead letters render through msg(), including the missing-error fallback', async () => {
    const driver = createMemoryDriver();
    const id = await enqueue(driver, 'send-email');
    await driver.claim({
      queues: ['default'],
      limit: 5,
      visibilityTimeoutMs: 60_000,
      workerId: 'w',
    });
    await driver.nack(id, { delayMs: 0, deadLetter: true }); // no `error`: nothing was recorded

    const result = await runJobs(driver, { subcommand: 'ls' });
    const rendered = (result.lines ?? []).join('\n');

    expect(rendered).toContain(msg('cli.jobs.deadLetters', { count: 1 }));
    expect(rendered).toContain(msg('cli.jobs.noError'));
    expect(rendered).toContain(`x jobs retry ${id}`);
    // The catalog is the only source: a key that is missing renders ⟦key⟧, never English.
    expect(rendered).not.toContain('⟦');
  });

  test('a pass in flight is reported with how far it has got, and finished ones are not', async () => {
    const driver = createMemoryDriver();
    await driver.backfills?.start({
      runId: 'run_live',
      name: 'reindex-posts',
      checksum: 'abc123',
      appVersion: '1.2.0',
    });
    await driver.backfills?.progress('run_live', { rows: 250, cursor: 'post_250' });
    await driver.backfills?.start({
      runId: 'run_old',
      name: 'recount-likes',
      checksum: 'abc123',
      appVersion: '1.2.0',
    });
    await driver.backfills?.finish('run_old', { status: 'completed', rows: 900 });

    const result = await runJobs(driver, { subcommand: 'ls' });
    const rendered = (result.lines ?? []).join('\n');

    expect(rendered).toContain(msg('cli.jobs.backfills', { count: 1 }));
    expect(rendered).toContain(
      msg('cli.jobs.backfillRow', { name: 'reindex-posts', rows: 250, cursor: 'post_250' }),
    );
    expect(rendered).toContain('run_live');
    // `x jobs ls` is the LIVE queue — a pass that finished is `x db backfill --list`'s answer.
    expect(rendered).not.toContain('recount-likes');
    expect(rendered).not.toContain('⟦');
    expect(result.data).toMatchObject({ backfills: [{ runId: 'run_live', status: 'running' }] });
  });

  test('a pass that has not reached its first batch says so instead of printing null', async () => {
    const driver = createMemoryDriver();
    await driver.backfills?.start({
      runId: 'run_new',
      name: 'reindex-posts',
      checksum: 'abc123',
      appVersion: '1.2.0',
    });

    const rendered = ((await runJobs(driver, { subcommand: 'ls' })).lines ?? []).join('\n');

    expect(rendered).toContain(msg('cli.jobs.backfillNoCursor'));
    expect(rendered).not.toContain('null');
  });

  test('no backfill in flight renders no section at all', async () => {
    const driver = createMemoryDriver();
    await enqueue(driver, 'send-email');

    const result = await runJobs(driver, { subcommand: 'ls' });

    expect((result.lines ?? []).join('\n')).not.toContain(msg('cli.jobs.backfills', { count: 0 }));
    expect(result.data).toMatchObject({ backfills: [] });
  });

  test('a bad --limit fails the command through X_CLI_BAD_FLAG', async () => {
    const driver = createMemoryDriver();
    await expect(runJobs(driver, { subcommand: 'ls', flags: { limit: '0' } })).rejects.toThrow(
      BadFlagError,
    );
  });
});

describe('unit · x jobs show and retry rendering', () => {
  test('show renders the trace and its state', async () => {
    const driver = createMemoryDriver();
    const id = await enqueue(driver, 'send-email');

    const result = await runJobs(driver, { subcommand: 'show', positionals: [id] });

    expect(result.ok).toBe(true);
    expect(result.summary).toBe(
      msg('cli.jobs.shown', { id, state: 'ready', attempt: 0, attempts: 3 }),
    );
  });

  // `MissingPositionalError`, and the CODE cannot say so — both classes raise X_CLI_BAD_FLAG. The
  // cause is where `--id on "x jobs"` used to send a reader to a flag `x jobs` does not declare.
  test('a missing id names the positional, and the fix is a command that lists ids', async () => {
    const driver = createMemoryDriver();
    for (const subcommand of ['show', 'retry']) {
      const thrown: unknown = await runJobs(driver, { subcommand }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(thrown).toBeInstanceOf(MissingPositionalError);
      const error = thrown as MissingPositionalError;
      expect([subcommand, error.cause]).toEqual([
        subcommand,
        `"x jobs ${subcommand}" needs a <id> positional and got none`,
      ]);
      expect(error.fix).toBe('x jobs ls --json');
    }
  });

  test('retry re-queues and reports the new state', async () => {
    const driver = createMemoryDriver();
    const id = await enqueue(driver, 'send-email');

    const result = await runJobs(driver, { subcommand: 'retry', positionals: [id] });

    expect(result.summary).toBe(msg('cli.jobs.retried', { id, state: 'ready' }));
  });
});

describe('unit · x jobs cancel', () => {
  test('a job past cancelling is refused, never silently reported as cancelled', async () => {
    const driver = createMemoryDriver();
    const id = await enqueue(driver, 'send-email');
    await driver.claim({
      queues: ['default'],
      limit: 1,
      workerId: 'w1',
      visibilityTimeoutMs: 1000,
    });
    await driver.ack(id);

    // The failure case: a `done` job has nothing to stop, and cancelling it would rewrite a
    // terminal row an operator is reading as success — so there is no path where this command
    // exits 0 over a job whose state it did not change.
    await expect(runJobs(driver, { subcommand: 'cancel', positionals: [id] })).rejects.toThrow(
      /X_JOB_NOT_CANCELLABLE/,
    );
  });

  test('a live job is cancelled and the trace is rendered by the same projection show uses', async () => {
    const driver = createMemoryDriver();
    const id = await enqueue(driver, 'send-email');

    const result = await runJobs(driver, {
      subcommand: 'cancel',
      positionals: [id],
      flags: { reason: 'superseded by a newer charge' },
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toBe(msg('cli.jobs.cancelled', { id, state: 'cancelled' }));
    expect((result.data as { id: string; state: string }).state).toBe('cancelled');
  });

  test('a missing id names the positional, for cancel as for show and retry', async () => {
    await expect(runJobs(createMemoryDriver(), { subcommand: 'cancel' })).rejects.toThrow(
      MissingPositionalError,
    );
  });
});

describe('unit · x jobs drain rendering', () => {
  test('a complete drain is ok and reports the moved count', async () => {
    const driver = createMemoryDriver();
    await enqueue(driver, 'send-email');

    const result = await runJobs(driver, { subcommand: 'drain', flags: { to: 'memory' } });

    expect(result.ok).toBe(true);
    expect(result.summary).toBe(
      msg('cli.jobs.drained', { count: 1, from: 'memory', to: 'memory' }),
    );
    expect(result.lines).toEqual([]);
  });

  test('a partial drain fails the command and lists what was left behind', async () => {
    const driver = createMemoryDriver();
    await enqueue(driver, 'later-job', Date.now() + 60_000);

    const result = await runJobs(driver, { subcommand: 'drain', flags: { to: 'memory' } });

    // A partial move that exited 0 would read as "the queue is clear". It is not.
    expect(result.ok).toBe(false);
    expect(result.summary).toBe(
      msg('cli.jobs.drainedPartial', { count: 0, from: 'memory', to: 'memory', skipped: 1 }),
    );
    expect(result.lines?.[0]).toContain(msg('cli.jobs.skipped', { count: 1, from: 'memory' }));
    expect(result.lines?.[1]).toContain('later-job');
    expect((result.lines ?? []).join('\n')).not.toContain('⟦');
  });

  test('--dry-run reports the candidates and moves nothing', async () => {
    const driver = createMemoryDriver();
    const id = await enqueue(driver, 'send-email');

    const result = await runJobs(driver, {
      subcommand: 'drain',
      flags: { to: 'memory', 'dry-run': true },
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toBe(
      msg('cli.jobs.drained', { count: 1, from: 'memory', to: 'memory' }),
    );
    expect((await driver.introspect?.job(id))?.state).toBe('ready');
  });

  test('an unreachable target is a finding, not a throw', async () => {
    const driver = createMemoryDriver();
    await enqueue(driver, 'send-email');

    const result = await runJobs(driver, {
      subcommand: 'drain',
      flags: { to: 'redis' },
      env: { REDIS_URL: 'redis://localhost:6379' },
    });

    expect(result.ok).toBe(false);
    expect(result.findings?.[0]?.code).toBe('X_NOT_IMPLEMENTED');
  });
});

describe('unit · x jobs drain target', () => {
  test('an unknown or missing --to value throws X_CLI_BAD_FLAG naming the accepted values', () => {
    expect(() => buildDrainTarget('sqs', {})).toThrow(BadFlagError);
    expect(() => buildDrainTarget(undefined, {})).toThrow(BadFlagError);
  });

  test('--to memory needs no environment variable', () => {
    expect(buildDrainTarget('memory', {}).name).toBe('memory');
  });

  test('redis and nats each need their own URL in the environment', () => {
    expect(() => buildDrainTarget('redis', {})).toThrow(BadFlagError);
    expect(() => buildDrainTarget('nats', {})).toThrow(BadFlagError);
    expect(buildDrainTarget('redis', { REDIS_URL: 'redis://localhost:6379' }).name).toBe('redis');
    expect(buildDrainTarget('nats', { NATS_URL: 'nats://localhost:4222' }).name).toBe('nats');
  });
});
