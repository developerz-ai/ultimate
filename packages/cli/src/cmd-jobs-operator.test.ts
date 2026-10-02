// The operator half of `x jobs`: `pause`, `resume`, `rm`, `promote`, paging, and what `show`
// carries for an operator — the key, the payload, the stack, the progress. Split off
// `cmd-jobs.test.ts` at the file-size ceiling; same harness (`cmd-jobs-fixture.ts`).

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no synchronous mkdir or write, and these fixture files must exist before the command runs.
import { mkdirSync, writeFileSync } from 'node:fs';
// why: Bun exposes no path-join primitive; import() takes one already joined.
import { join } from 'node:path';
import {
  createMemoryDriver,
  JobKeyBusyError,
  job,
  resetJobDriver,
  resetJobs,
  setJobDriver,
  t,
} from '@ultimat3/jobs';
import { jobsCommand } from './cmd-jobs';
import { appRoot, contextFor, enqueue, runJobs } from './cmd-jobs-fixture';
import { BadFlagError, MissingPositionalError } from './errors';
import { msg } from './messages';
import { flagString, parseArgs } from './parse';

afterEach(() => {
  resetJobDriver();
  resetJobs();
});

describe('unit · x jobs show, for an operator', () => {
  test('show names the concurrency key a keyed run counts under, and null for any other', async () => {
    const driver = createMemoryDriver();
    job({
      name: 'sync-account',
      tenant: 'none',
      input: t.object({ account: t.string }),
      idempotencyKey: ({ account }) => `sync:${account}`,
      retry: { attempts: 3 },
      concurrency: { key: ({ account }) => account, limit: 1 },
      run: () => Promise.resolve(),
    });
    const keyed = await driver.enqueue({
      name: 'sync-account',
      queue: 'default',
      input: { account: 'acct-42' },
      idempotencyKey: 'sync:acct-42',
      maxAttempts: 3,
    });
    const unkeyed = await enqueue(driver, 'send-email');

    const shown = await runJobs(driver, { subcommand: 'show', positionals: [keyed.id] });
    expect(shown.data).toMatchObject({ id: keyed.id, concurrencyKey: 'acct-42' });
    // The detail an operator opens: the payload (redacted by the queue), the stack, the progress.
    expect(shown.data).toMatchObject({
      input: { account: 'acct-42' },
      stack: null,
      progress: null,
    });
    const other = await runJobs(driver, { subcommand: 'show', positionals: [unkeyed] });
    expect(other.data).toMatchObject({ concurrencyKey: null });
  });

  // The same question, asked the way an operator asks it: in a CLI process that has registered
  // NOTHING. The case above declares its job in the test process, which is why it passed while
  // `x jobs show` printed `concurrencyKey: null` (and no retry schedule) for every keyed run of a
  // real app — the command read the queue and never loaded the declarations it projects through.
  test('show loads the app, so the key comes from a job only the APP declares', async () => {
    const driver = createMemoryDriver();
    const root = appRoot();
    const jobsEntry = join(import.meta.dir, '../../jobs/src/index.ts');
    mkdirSync(join(root, 'apps/web/app/sync'), { recursive: true });
    writeFileSync(
      join(root, 'apps/web/app/sync/jobs.ts'),
      [
        `import { job, t } from ${JSON.stringify(jobsEntry)};`,
        'export const cliLoadedSync = job({',
        "  name: 'cli-loaded-sync',",
        "  tenant: 'none',",
        '  input: t.object({ account: t.string }),',
        "  idempotencyKey: ({ account }) => 'sync:' + account,",
        "  retry: { attempts: 3, backoff: 'fixed', delay: 1_000, jitter: false },",
        "  concurrency: { key: ({ account }) => account, limit: 1, whenBusy: 'fail' },",
        '  run: () => Promise.resolve(),',
        '});',
        '',
      ].join('\n'),
    );
    const { id } = await driver.enqueue({
      name: 'cli-loaded-sync',
      queue: 'default',
      input: { account: 'acct-42' },
      idempotencyKey: 'sync:acct-42',
      maxAttempts: 3,
    });
    setJobDriver(driver);

    const shown = await jobsCommand.run(
      contextFor(root, { subcommand: 'show', positionals: [id] }),
    );

    expect(shown.data).toMatchObject({
      id,
      concurrencyKey: 'acct-42',
      retryDelaysMs: [1_000, 1_000],
    });
  });

  // X_JOB_KEY_BUSY's `fix:` is a command, so it is RUN here: parsed by the real parser against
  // the real spec, then executed. A flag the spec does not declare fails the first half.
  test('the fix X_JOB_KEY_BUSY prints is a command x jobs accepts and answers', async () => {
    const fix = new JobKeyBusyError({ job: 'sync-account', key: 'acct-42', limit: 1 }).fix;
    expect(fix).toBe('x jobs ls --name sync-account --state running --json');

    const args = parseArgs(fix.split(' ').slice(1), [jobsCommand.spec]);
    expect(args.subcommand).toBe('ls');
    expect(args.json).toBe(true);
    expect(flagString(args, 'name')).toBe('sync-account');
    expect(flagString(args, 'state')).toBe('running');

    const driver = createMemoryDriver();
    const result = await runJobs(driver, {
      subcommand: 'ls',
      flags: { name: 'sync-account', state: 'running' },
    });
    expect(result.ok).toBe(true);
  });
});

describe('unit · x jobs pause, resume, rm and promote', () => {
  test('pause stops every claim on that queue, resume undoes it, and ls reports it', async () => {
    const driver = createMemoryDriver();
    const id = await enqueue(driver, 'send-email');
    const claim = () =>
      driver.claim({ queues: ['default'], limit: 5, visibilityTimeoutMs: 30_000, workerId: 'w' });

    const paused = await runJobs(driver, { subcommand: 'pause', positionals: ['default'] });
    expect(paused.ok).toBe(true);
    expect(paused.summary).toBe(msg('cli.jobs.paused', { queue: 'default' }));
    expect(paused.data).toMatchObject({ queue: 'default', paused: true });
    expect(await claim()).toEqual([]);

    const listed = await runJobs(driver, { subcommand: 'ls' });
    expect(listed.data).toMatchObject({ pausedQueues: [{ name: 'default' }], workers: [] });
    expect(listed.lines?.join('\n')).toContain(msg('cli.jobs.pausedQueues', { queues: 'default' }));

    const resumed = await runJobs(driver, { subcommand: 'resume', positionals: ['default'] });
    expect(resumed.data).toMatchObject({ queue: 'default', paused: false, pausedQueues: [] });
    expect((await claim()).map((row) => row.id)).toEqual([id]);
  });

  test('pause and resume name the queue positional when it is missing', async () => {
    const driver = createMemoryDriver();
    for (const subcommand of ['pause', 'resume']) {
      const refusal = await runJobs(driver, { subcommand }).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(MissingPositionalError);
      expect((refusal as { fix: string }).fix).toContain(`x jobs ${subcommand} default --json`);
    }
  });

  test('rm removes a queued job, refuses a running one, and an unknown id is X_JOB_UNKNOWN', async () => {
    const driver = createMemoryDriver();
    const queued = await enqueue(driver, 'send-email', Date.now() + 60_000);
    const held = await enqueue(driver, 'send-email');
    await driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'w',
    });

    const removed = await runJobs(driver, { subcommand: 'rm', positionals: [queued] });
    expect(removed.summary).toBe(msg('cli.jobs.removed', { id: queued, state: 'delayed' }));
    expect(await driver.introspect?.job(queued)).toBeUndefined();

    const running = await runJobs(driver, { subcommand: 'rm', positionals: [held] }).catch(
      (error: unknown) => error,
    );
    expect(running).toMatchObject({
      code: 'X_JOB_NOT_REMOVABLE',
      fix: `x jobs cancel ${held} --json`,
    });
    const unknown = await runJobs(driver, { subcommand: 'rm', positionals: [queued] }).catch(
      (error: unknown) => error,
    );
    expect(unknown).toMatchObject({ code: 'X_JOB_UNKNOWN' });
  });

  test('promote makes a delayed job due, and says why a job that is not waiting cannot be', async () => {
    const driver = createMemoryDriver();
    const delayed = await enqueue(driver, 'send-email', Date.now() + 60_000);
    const due = await enqueue(driver, 'send-email');

    const promoted = await runJobs(driver, { subcommand: 'promote', positionals: [delayed] });
    expect(promoted.summary).toBe(msg('cli.jobs.promoted', { id: delayed }));
    expect(promoted.data).toMatchObject({ id: delayed, state: 'ready' });

    const refused = await runJobs(driver, { subcommand: 'promote', positionals: [due] }).catch(
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({
      code: 'X_JOB_NOT_PROMOTABLE',
      fix: `x jobs show ${due} --json`,
    });
  });
});

describe('unit · x jobs ls paging', () => {
  test('a full page answers the cursor of the next, and the last page answers null', async () => {
    const driver = createMemoryDriver();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) ids.push(await enqueue(driver, 'send-email'));

    const first = await runJobs(driver, { subcommand: 'ls', flags: { limit: '2' } });
    const page = first.data as { rows: { id: string }[]; next: string | null };
    expect(page.rows).toHaveLength(2);
    expect(typeof page.next).toBe('string');
    expect(first.lines?.join('\n')).toContain(`x jobs ls --after ${page.next}`);

    const seen = page.rows.map((row) => row.id);
    let after = page.next;
    while (after !== null) {
      const result = await runJobs(driver, { subcommand: 'ls', flags: { limit: '2', after } });
      const next = result.data as { rows: { id: string }[]; next: string | null };
      seen.push(...next.rows.map((row) => row.id));
      after = next.next;
    }
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(5);
  });

  test('a page past the queue`s bound is a flag error naming the walk', async () => {
    const driver = createMemoryDriver();
    const refusal = await runJobs(driver, { subcommand: 'ls', flags: { limit: '201' } }).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(BadFlagError);
    expect((refusal as { fix: string }).fix).toContain('x jobs ls --limit 200 --json');
  });
});
