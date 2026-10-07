// The command surface of `x jobs`: the spec, the planned `drain`, and what `run()` actually
// renders. Driven through an ambient `memoryJobDriver()` so `withJobDriver` reuses it instead of
// booting a queue — a real driver, real claim/ack semantics, no database and no app to load.

import { afterEach, describe, expect, test } from 'bun:test';
import type { JobDriver } from '@ultimat3/jobs';
import { memoryJobDriver, resetJobDriver, resetJobs } from '@ultimat3/jobs';
import { JOBS_SUBCOMMANDS, jobsCommand } from './cmd-jobs';
import { appRoot, contextFor, enqueue, runJobs } from './cmd-jobs-fixture';
import { BadFlagError, MissingPositionalError } from './errors';
import { msg } from './messages';

afterEach(() => {
  resetJobDriver();
  resetJobs();
});

describe('unit · x jobs spec', () => {
  test('names every subcommand, ls first, with every documented flag', () => {
    expect(JOBS_SUBCOMMANDS).toEqual([
      'ls',
      'show',
      'retry',
      'cancel',
      'rm',
      'promote',
      'pause',
      'resume',
      'drain',
    ]);
    expect(jobsCommand.spec.subcommands).toBe(JOBS_SUBCOMMANDS);
    expect(jobsCommand.spec.name).toBe('jobs');
    expect(jobsCommand.spec.requiresApp).toBe(true);
    expect(jobsCommand.spec.flags?.map((flag) => flag.name).sort()).toEqual(
      ['after', 'from-step', 'limit', 'name', 'queue', 'reason', 'state'].sort(),
    );
  });
});

describe('unit · x jobs ls rendering', () => {
  test('the row count, the table and the depth summary all come from the catalog', async () => {
    const driver = memoryJobDriver();
    await enqueue(driver, 'send-email');

    const result = await runJobs(driver, { subcommand: 'ls' });

    expect(result.ok).toBe(true);
    expect(result.lines?.[0]).toBe(`  ${msg('cli.jobs.listed', { count: 1 })}`);
    expect(result.lines?.[1]).toContain('run-at-ms');
    expect(result.summary).toContain('1 ready');
  });

  test('dead letters render through msg(), including the missing-error fallback', async () => {
    const driver = memoryJobDriver();
    const id = await enqueue(driver, 'send-email');
    await driver.claim({
      queues: ['default'],
      limit: 5,
      visibilityTimeoutMs: 60_000,
      workerId: 'w',
    });
    await driver.nack(id, { workerId: 'w', claim: 1, delayMs: 0, deadLetter: true }); // no `error`: nothing was recorded

    const result = await runJobs(driver, { subcommand: 'ls' });
    const rendered = (result.lines ?? []).join('\n');

    expect(rendered).toContain(msg('cli.jobs.deadLetters', { count: 1 }));
    expect(rendered).toContain(msg('cli.jobs.noError'));
    expect(rendered).toContain(`x jobs retry ${id}`);
    // The catalog is the only source: a key that is missing renders ⟦key⟧, never English.
    expect(rendered).not.toContain('⟦');
  });

  test('a pass in flight is reported with how far it has got, and finished ones are not', async () => {
    const driver = memoryJobDriver();
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
    const driver = memoryJobDriver();
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
    const driver = memoryJobDriver();
    await enqueue(driver, 'send-email');

    const result = await runJobs(driver, { subcommand: 'ls' });

    expect((result.lines ?? []).join('\n')).not.toContain(msg('cli.jobs.backfills', { count: 0 }));
    expect(result.data).toMatchObject({ backfills: [] });
  });

  test('a bad --limit fails the command through X_CLI_BAD_FLAG', async () => {
    const driver = memoryJobDriver();
    await expect(runJobs(driver, { subcommand: 'ls', flags: { limit: '0' } })).rejects.toThrow(
      BadFlagError,
    );
  });
});

describe('unit · x jobs show and retry rendering', () => {
  test('show renders the trace and its state', async () => {
    const driver = memoryJobDriver();
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
    const driver = memoryJobDriver();
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

  // `x_jobs.id` is a uuid column: `x jobs show nosuch` reached Postgres and came back a raw
  // `X_DB_STATEMENT_FAILED [22P02]` with a psql fix. An id no driver could hold is answered at the
  // door, before a statement is sent — for every subcommand that takes one.
  test('an id that is not a job id is X_JOB_UNKNOWN, and no driver is asked', async () => {
    for (const subcommand of ['show', 'retry', 'cancel', 'rm', 'promote']) {
      const driver = memoryJobDriver();
      const asked: string[] = [];
      const introspect = driver.introspect;
      const watched: JobDriver = {
        ...driver,
        ...(introspect === undefined
          ? {}
          : {
              introspect: new Proxy(introspect, {
                get(target, key, receiver) {
                  asked.push(String(key));
                  return Reflect.get(target, key, receiver);
                },
              }),
            }),
      };
      const thrown: unknown = await runJobs(watched, {
        subcommand,
        positionals: ['nosuch'],
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect([subcommand, (thrown as { code?: string }).code]).toEqual([
        subcommand,
        'X_JOB_UNKNOWN',
      ]);
      expect([subcommand, asked]).toEqual([subcommand, []]);
    }
  });

  test('retry re-queues and reports the new state', async () => {
    const driver = memoryJobDriver();
    const id = await enqueue(driver, 'send-email');
    // Retry accepts a FINISHED job only (`X_JOB_NOT_REQUEUEABLE` otherwise), so dead-letter it first.
    await driver.claim({
      queues: ['default'],
      limit: 1,
      workerId: 'w1',
      visibilityTimeoutMs: 1000,
    });
    await driver.nack(id, { workerId: 'w1', claim: 1, delayMs: 0, deadLetter: true });

    const result = await runJobs(driver, { subcommand: 'retry', positionals: [id] });

    expect(result.summary).toBe(msg('cli.jobs.retried', { id, state: 'ready' }));
  });
});

describe('unit · x jobs cancel', () => {
  test('a job past cancelling is refused, never silently reported as cancelled', async () => {
    const driver = memoryJobDriver();
    const id = await enqueue(driver, 'send-email');
    await driver.claim({
      queues: ['default'],
      limit: 1,
      workerId: 'w1',
      visibilityTimeoutMs: 1000,
    });
    await driver.ack(id, { workerId: 'w1', claim: 1 });

    // The failure case: a `done` job has nothing to stop, and cancelling it would rewrite a
    // terminal row an operator is reading as success — so there is no path where this command
    // exits 0 over a job whose state it did not change.
    await expect(runJobs(driver, { subcommand: 'cancel', positionals: [id] })).rejects.toThrow(
      /X_JOB_NOT_CANCELLABLE/,
    );
  });

  test('a live job is cancelled and the trace is rendered by the same projection show uses', async () => {
    const driver = memoryJobDriver();
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
    await expect(runJobs(memoryJobDriver(), { subcommand: 'cancel' })).rejects.toThrow(
      MissingPositionalError,
    );
  });
});

// The `redis` target was an `X_NOT_IMPLEMENTED` stub on every method, so a drain onto it LEASED the
// whole batch off the production queue for `DRAIN_LEASE_MS` (5 min), failed every enqueue and
// nacked it back — five minutes in which no source worker could claim a job, for a command that
// could never move one. `drain` is a planned subcommand until a durable second driver ships, and
// 25.0.0 deleted the stub and its `--to`/`--dry-run` flags: the parser refuses them as unknown.
describe('unit · x jobs drain is planned', () => {
  test('drain refuses before leasing', async () => {
    const memory = memoryJobDriver();
    const id = await enqueue(memory, 'send-email');
    let claims = 0;
    const counted: JobDriver = {
      ...memory,
      claim: (options) => {
        claims += 1;
        return memory.claim(options);
      },
    };

    const thrown: unknown = await runJobs(counted, {
      subcommand: 'drain',
      flags: {},
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeUltimateError('X_NOT_IMPLEMENTED');
    expect((thrown as { cause?: string }).cause).toBe(
      'x jobs drain is not implemented in this build',
    );
    expect(claims).toBe(0);
    const row = await memory.introspect?.job(id);
    expect(row?.state).toBe('ready');
    expect(row?.attempt).toBe(0);
  });

  // ORDERING: the planned answer needs no server, so a box whose database is down must get it
  // rather than the boot failure of a queue the command would never have used.
  test('the planned answer arrives with no ambient driver, before any queue is booted', async () => {
    resetJobDriver();
    const thrown: unknown = await jobsCommand
      .run(
        contextFor(appRoot(), {
          subcommand: 'drain',
          flags: {},
          env: { DATABASE_URL: 'postgres://x:y@127.0.0.1:1/none' },
        }),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(thrown).toBeUltimateError('X_NOT_IMPLEMENTED');
  });

  test("its fix is the planned table's, a command this build ships", async () => {
    const thrown: unknown = await runJobs(memoryJobDriver(), { subcommand: 'drain' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((thrown as { fix?: string }).fix).toStartWith('x jobs ls');
  });
});
