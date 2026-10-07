// The command surface of `x jobs`: the spec, the `--to` validation, and what `run()` actually
// renders. Driven through an ambient `memoryJobDriver()` so `withJobDriver` reuses it instead of
// booting a queue — a real driver, real claim/ack semantics, no database and no app to load.

import { afterEach, describe, expect, test } from 'bun:test';
import type { JobDriver } from '@ultimat3/jobs';
import { memoryJobDriver, resetJobDriver, resetJobs } from '@ultimat3/jobs';
import {
  buildDrainTarget,
  DRAIN_TARGETS,
  drainJobs,
  drainResult,
  JOBS_SUBCOMMANDS,
  jobsCommand,
} from './cmd-jobs';
import { appRoot, contextFor, enqueue, runJobs } from './cmd-jobs-fixture';
import { BadFlagError, MissingPositionalError } from './errors';
import { msg } from './messages';
import type { CommandResult } from './output';

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
      ['after', 'dry-run', 'from-step', 'limit', 'name', 'queue', 'reason', 'state', 'to'].sort(),
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

describe('unit · x jobs drain rendering', () => {
  /** The command path can no longer reach an in-process target, so the outcome is produced with
   *  two real drivers and handed to the same renderer `runDrain` uses. */
  const rendered = async (source: JobDriver, dryRun = false): Promise<CommandResult> =>
    drainResult(await drainJobs(source, memoryJobDriver(), dryRun));

  test('a complete drain is ok and reports the moved count', async () => {
    const driver = memoryJobDriver();
    await enqueue(driver, 'send-email');

    const result = await rendered(driver);

    expect(result.ok).toBe(true);
    expect(result.summary).toBe(
      msg('cli.jobs.drained', { count: 1, from: 'memory', to: 'memory' }),
    );
    expect(result.lines).toEqual([]);
  });

  test('a partial drain fails the command and lists what was left behind', async () => {
    const driver = memoryJobDriver();
    await enqueue(driver, 'later-job', Date.now() + 60_000);

    const result = await rendered(driver);

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
    const driver = memoryJobDriver();
    const id = await enqueue(driver, 'send-email');

    const result = await rendered(driver, true);

    expect(result.ok).toBe(true);
    expect(result.summary).toBe(
      msg('cli.jobs.drained', { count: 1, from: 'memory', to: 'memory' }),
    );
    expect((await driver.introspect?.job(id))?.state).toBe('ready');
  });
});

// The `redis` target was an `X_NOT_IMPLEMENTED` stub on every method, so a drain onto it LEASED the
// whole batch off the production queue for `DRAIN_LEASE_MS` (5 min), failed every enqueue and
// nacked it back — five minutes in which no source worker could claim a job, for a command that
// could never move one. `drain` is a planned subcommand until a durable second driver ships, and
// 25.0.0 deleted the stub: `--to redis` is now a value nothing accepts, and still the planned answer.
describe('unit · x jobs drain is planned', () => {
  test('drain --to redis refuses before leasing', async () => {
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
      flags: { to: 'redis' },
      env: { REDIS_URL: 'redis://localhost:6379' },
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

  test('every spelling of drain gets the same planned answer, --to memory and --dry-run included', async () => {
    for (const flags of [{ to: 'memory' }, { to: 'redis', 'dry-run': true }, {}]) {
      const thrown: unknown = await runJobs(memoryJobDriver(), {
        subcommand: 'drain',
        flags,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(thrown).toBeUltimateError('X_NOT_IMPLEMENTED');
    }
  });

  // ORDERING: the planned answer needs no server, so a box whose database is down must get it
  // rather than the boot failure of a queue the command would never have used.
  test('the planned answer arrives with no ambient driver, before any queue is booted', async () => {
    resetJobDriver();
    const thrown: unknown = await jobsCommand
      .run(
        contextFor(appRoot(), {
          subcommand: 'drain',
          flags: { to: 'redis' },
          env: { DATABASE_URL: 'postgres://x:y@127.0.0.1:1/none', REDIS_URL: 'redis://x:1' },
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

describe('unit · x jobs drain target', () => {
  test('an unknown or missing --to value throws X_CLI_BAD_FLAG naming the accepted values', () => {
    expect(() => buildDrainTarget('sqs', {})).toThrow(BadFlagError);
    expect(() => buildDrainTarget(undefined, {})).toThrow(BadFlagError);
  });

  // The bug: `--to memory` enqueued onto `memoryJobDriver()` — a Map inside THIS process — and
  // then acked every durable row off the source. Reproduced: source ready 1 -> 0, target ready 1
  // in a driver nothing can reach, `ok: true`, and the copy gone at exit. Held at the target
  // builder, which is what a re-enabled drain reads `--to` through.
  test('--to memory is refused by name, with a durable target in the fix', () => {
    const thrown: unknown = (() => {
      try {
        return buildDrainTarget('memory', {});
      } catch (error) {
        return error;
      }
    })();

    expect((thrown as { code?: string }).code).toBe('X_CLI_BAD_FLAG');
    expect((thrown as { cause?: string }).cause).toContain('this process');
    // A `fix:` naming the planned `x jobs drain` would hand its reader a second error.
    expect((thrown as { fix?: string }).fix).not.toContain('x jobs drain');
  });

  test('no target ships: the flag accepts no value, memory included', () => {
    expect(DRAIN_TARGETS).toEqual([]);
    expect(() => buildDrainTarget('memory', {})).toThrow(BadFlagError);
  });

  // 25.0.0 deleted the Redis jobs stub (every method threw `X_NOT_IMPLEMENTED`): `--to redis` is
  // refused at the flag, its URL in the environment or not, and the refusal says nothing ships.
  test('redis is refused as an unknown target, whatever the environment holds', () => {
    for (const env of [{}, { REDIS_URL: 'redis://localhost:6379' }]) {
      const thrown: unknown = (() => {
        try {
          return buildDrainTarget('redis', env);
        } catch (error) {
          return error;
        }
      })();
      expect(thrown).toBeInstanceOf(BadFlagError);
      expect((thrown as { cause?: string }).cause).toContain('no durable drain target ships');
    }
  });

  // 25.0.0 deleted the NATS jobs stub: `--to nats` is a value the flag no longer accepts.
  test('nats is refused as an unknown target', () => {
    expect(() => buildDrainTarget('nats', { NATS_URL: 'nats://localhost:4222' })).toThrow(
      BadFlagError,
    );
  });
});
