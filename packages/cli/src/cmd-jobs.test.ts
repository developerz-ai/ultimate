// The command surface of `x jobs`: the spec and what `run()` actually
// renders. Driven through an ambient `memoryJobDriver()` so `withJobDriver` reuses it instead of
// booting a queue — a real driver, real claim/ack semantics, no database and no app to load.

import { afterEach, describe, expect, test } from 'bun:test';
import type { JobDriver } from '@ultimat3/jobs';
import { memoryJobDriver, resetJobs } from '@ultimat3/jobs';
import { resetJobDriver } from '@ultimat3/jobs/adapter';
import { JOBS_SUBCOMMANDS, jobsCommand } from './cmd-jobs';
import { enqueue, runJobs } from './cmd-jobs-fixture';
import { BadFlagError, MissingPositionalError } from './errors';
import { msg } from './messages';

afterEach(() => {
  resetJobDriver();
  resetJobs();
});

describe('unit · x jobs spec', () => {
  test('names every subcommand, list first, with every documented flag', () => {
    expect(JOBS_SUBCOMMANDS).toEqual([
      'list',
      'show',
      'retry',
      'cancel',
      'delete',
      'promote',
      'resolve-step',
      'pause',
      'resume',
    ]);
    expect(jobsCommand.spec.subcommands).toBe(JOBS_SUBCOMMANDS);
    expect(jobsCommand.spec.name).toBe('jobs');
    expect(jobsCommand.spec.requiresApp).toBe(true);
    expect(jobsCommand.spec.flags?.map((flag) => flag.name).sort()).toEqual(
      [
        'after',
        'from-step',
        'limit',
        'name',
        'not-ran',
        'output',
        'queue',
        'ran',
        'reason',
        'state',
      ].sort(),
    );
  });
});

describe('unit · x jobs list rendering', () => {
  test('the row count, the table and the depth summary all come from the catalog', async () => {
    const driver = memoryJobDriver();
    await enqueue(driver, 'send-email');

    const result = await runJobs(driver, { subcommand: 'list' });

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

    const result = await runJobs(driver, { subcommand: 'list' });
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

    const result = await runJobs(driver, { subcommand: 'list' });
    const rendered = (result.lines ?? []).join('\n');

    expect(rendered).toContain(msg('cli.jobs.backfills', { count: 1 }));
    expect(rendered).toContain(
      msg('cli.jobs.backfillRow', { name: 'reindex-posts', rows: 250, cursor: 'post_250' }),
    );
    expect(rendered).toContain('run_live');
    // `x jobs list` is the LIVE queue — a pass that finished is `x db backfill --list`'s answer.
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

    const rendered = ((await runJobs(driver, { subcommand: 'list' })).lines ?? []).join('\n');

    expect(rendered).toContain(msg('cli.jobs.backfillNoCursor'));
    expect(rendered).not.toContain('null');
  });

  test('no backfill in flight renders no section at all', async () => {
    const driver = memoryJobDriver();
    await enqueue(driver, 'send-email');

    const result = await runJobs(driver, { subcommand: 'list' });

    expect((result.lines ?? []).join('\n')).not.toContain(msg('cli.jobs.backfills', { count: 0 }));
    expect(result.data).toMatchObject({ backfills: [] });
  });

  test('a bad --limit fails the command through X_CLI_BAD_FLAG', async () => {
    const driver = memoryJobDriver();
    await expect(runJobs(driver, { subcommand: 'list', flags: { limit: '0' } })).rejects.toThrow(
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
      expect(error.fix).toBe('x jobs list --json');
    }
  });

  // `x_jobs.id` is a uuid column: `x jobs show nosuch` reached Postgres and came back a raw
  // `X_DB_STATEMENT_FAILED [22P02]` with a psql fix. An id no driver could hold is answered at the
  // door, before a statement is sent — for every subcommand that takes one.
  test('an id that is not a job id is X_JOB_UNKNOWN, and no driver is asked', async () => {
    for (const subcommand of ['show', 'retry', 'cancel', 'delete', 'promote']) {
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

// `x jobs drain` left the registry (`cmd-planned-removed.test.ts`): the parser refuses it before
// any `run`, so nothing is leased and no queue boots.
