// The command surface of `x tasks`: the spec, the table and summary `run()` renders, the `show`
// detail view, and the error paths — driven against `@ultimat3/jobs`'s real registries so a
// broken table column or a wrong fix line fails here, not just in `tasks-facts.test.ts`.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { job, resetJobs, resetTasks, t, task } from '@ultimat3/jobs';
import { tasksCommand } from './cmd-tasks';
import type { CommandContext } from './command';
import { msg } from './messages';
import type { ThrownShape } from './thrown-by';

function appRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'x-tasks-'));
  writeFileSync(join(dir, 'app.config.ts'), 'export const config = {};\n');
  return dir;
}

/** Same shape as `appRoot()`, plus one module that fails to import — `x tasks`' finding path. */
function brokenAppRoot(): string {
  const dir = appRoot();
  mkdirSync(join(dir, 'apps/web/app'), { recursive: true });
  writeFileSync(join(dir, 'apps/web/app/broken.ts'), "export { nope } from './does-not-exist';\n");
  return dir;
}

interface RunOptions {
  readonly subcommand?: string;
  readonly positionals?: readonly string[];
  readonly flags?: Readonly<Record<string, string | boolean>>;
}

const contextFor = (root: string, options: RunOptions = {}): CommandContext => ({
  args: {
    command: 'tasks',
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
  env: {},
  bunVersion: '1.3.0',
});

/** The thrown value, so a test can assert on `code`/`fix` — `run()` rejects on a bad flag or an
 * unknown declaration, it never returns an `ok: false` result for either. */
async function rejectedBy(call: () => Promise<unknown>): Promise<ThrownShape> {
  try {
    await call();
  } catch (error) {
    return error as ThrownShape;
  }
  return expect.unreachable('expected a rejection');
}

/**
 * `run()` reads `systemClock`, which `scripts/test-setup.ts` has already frozen for every test in
 * this repo — so the expected instants below are derived from that one instant rather than from a
 * clock this file installs. `@ultimat3/testing`'s scoped `frozenClock` would be the obvious tool
 * and is a tier-5 sideways import the boundaries gate refuses; the time math it would have pinned
 * (both sides of a DST flip) is pinned in `tasks-facts.test.ts`, which takes `nowMs` outright.
 */
const NOW_MS = Date.parse('2026-01-01T00:00:00Z');
/** 19:00 EST on 2025-12-31 locally, so the next `0 3 * * *` is 03:00 EST the same UTC day. */
const NEXT_MS = Date.parse('2026-01-01T08:00:00Z');
const NEXT_AT = '2026-01-01T03:00:00-05:00';

// Deliberately not a "ping"-ish name: it must never overlap a substring of `nightlyPing`, or a
// `toContain` assertion on the rendered jobs column would pass even if that column were broken.
function pingJob(name = 'notify') {
  return job({
    name,
    input: t.object({}),
    idempotencyKey: () => name,
    retry: { attempts: 1 },
    run: () => Promise.resolve(),
  });
}

function registerNightlyPing(): void {
  // Built once and captured by the closure — `enqueue` runs on every `describe()`/`entries()`
  // call, and `job()` refuses a second registration under the same name.
  const notify = pingJob();
  task({
    name: 'nightlyPing',
    cron: '0 3 * * *',
    tz: 'America/New_York',
    enqueue: () => [[notify, {}]],
  });
}

afterEach(() => {
  resetTasks();
  resetJobs();
});

describe('unit · x tasks spec', () => {
  test('names both subcommands, list first, with the --count flag', () => {
    expect(tasksCommand.spec.name).toBe('tasks');
    expect(tasksCommand.spec.requiresApp).toBe(true);
    expect(tasksCommand.spec.subcommands).toEqual(['list', 'show']);
    expect(tasksCommand.spec.summary).toBe('cron tasks, their timezone and their next run');
    expect(tasksCommand.spec.flags?.map((flag) => flag.name)).toEqual(['count']);
  });
});

describe('unit · x tasks list', () => {
  test('a row per task, jobs comma-joined, and the full fact array under data', async () => {
    registerNightlyPing();
    const result = await tasksCommand.run(contextFor(appRoot(), { subcommand: 'list' }));
    expect(Date.now()).toBe(NOW_MS);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(msg('cli.tasks.count', { count: 1 }));
    expect(result.lines?.[0]).toContain('name');
    expect(result.lines?.[0]).toContain('next');
    const row = result.lines?.find((line) => line.includes('nightlyPing'));
    expect(row).toContain('0 3 * * *');
    expect(row).toContain('America/New_York');
    expect(row).toContain('notify');
    // EST, not an ambient UTC offset: the whole point of a per-task tz.
    expect(row).toContain(NEXT_AT);
    expect(result.data).toEqual([
      {
        kind: 'task',
        name: 'nightlyPing',
        cron: '0 3 * * *',
        tz: 'America/New_York',
        catchUp: 'skip',
        maxCatchUp: 10,
        jobs: ['notify'],
        nextMs: NEXT_MS,
        next: NEXT_AT,
      },
    ]);
  });

  test('jobs renders as "-" for a task that enqueues nothing', async () => {
    task({ name: 'noop', cron: '* * * * *', tz: 'UTC', enqueue: () => [] });
    const result = await tasksCommand.run(contextFor(appRoot(), { subcommand: 'list' }));
    expect(result.data).toEqual([expect.objectContaining({ name: 'noop', jobs: [] })]);
    const row = result.lines?.find((line) => line.includes('noop'));
    // The jobs COLUMN specifically — every `next` cell contains a `-` too (it is an ISO date), so
    // a bare `toContain('-')` here would pass even if the jobs column leaked the job list.
    const cells = (row ?? '').trim().split(/\s{2,}/);
    expect(cells[4]).toBe('-');
  });

  test('the default subcommand is list — for run() given no subcommand at all', async () => {
    registerNightlyPing();
    const root = appRoot();
    const viaList = await tasksCommand.run(contextFor(root, { subcommand: 'list' }));
    const viaUndefined = await tasksCommand.run(contextFor(root, { subcommand: undefined }));
    expect(viaUndefined.summary).toBe(viaList.summary);
  });
});

describe('unit · x tasks show', () => {
  test('the descriptor, the human phrase and count upcoming occurrences', async () => {
    registerNightlyPing();
    const result = await tasksCommand.run(
      contextFor(appRoot(), {
        subcommand: 'show',
        positionals: ['nightlyPing'],
        flags: { count: '3' },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(
      msg('cli.tasks.shown', {
        name: 'nightlyPing',
        cron: '0 3 * * *',
        tz: 'America/New_York',
        next: NEXT_AT,
      }),
    );
    expect(result.lines).toContain('  name: nightlyPing');
    expect(result.lines).toContain('  cron: 0 3 * * *');
    expect(result.lines).toContain('  tz: America/New_York');
    expect(result.lines).toContain('  at 03:00 every day');
    expect(result.lines).toContain(`    ${NEXT_AT}`);
    expect(result.lines).toContain('    2026-01-03T03:00:00-05:00');
    expect(result.data).toEqual({
      kind: 'task',
      name: 'nightlyPing',
      cron: '0 3 * * *',
      tz: 'America/New_York',
      catchUp: 'skip',
      maxCatchUp: 10,
      jobs: ['notify'],
      describe: 'at 03:00 every day',
      upcoming: [
        { ms: NEXT_MS, at: NEXT_AT },
        { ms: Date.parse('2026-01-02T08:00:00Z'), at: '2026-01-02T03:00:00-05:00' },
        { ms: Date.parse('2026-01-03T08:00:00Z'), at: '2026-01-03T03:00:00-05:00' },
      ],
    });
  });

  test('--count defaults to 5 when omitted', async () => {
    registerNightlyPing();
    const result = await tasksCommand.run(
      contextFor(appRoot(), { subcommand: 'show', positionals: ['nightlyPing'] }),
    );
    expect((result.data as { upcoming: readonly unknown[] }).upcoming).toHaveLength(5);
  });
});

describe('unit · x tasks errors', () => {
  test('show with no positional is a bad-flag error naming the working invocation', async () => {
    const thrown = await rejectedBy(() =>
      tasksCommand.run(contextFor(appRoot(), { subcommand: 'show' })),
    );
    expect(thrown).toBeUltimateError('X_CLI_BAD_FLAG');
    expect(thrown.fix).toBe('x tasks list --json');
  });

  test('show <typo> is an unknown-declaration error whose fix says "show", not "describe"', async () => {
    registerNightlyPing();
    const thrown = await rejectedBy(() =>
      tasksCommand.run(contextFor(appRoot(), { subcommand: 'show', positionals: ['nightlyPin'] })),
    );
    expect(thrown).toBeUltimateError('X_DECLARATION_UNKNOWN');
    expect(thrown.cause).toContain('nightlyPin');
    expect(thrown.fix).toBe('x tasks show nightlyPing');
  });

  test('show <unrelated> falls back to list --json when nothing is close enough to suggest', async () => {
    registerNightlyPing();
    const thrown = await rejectedBy(() =>
      tasksCommand.run(
        contextFor(appRoot(), { subcommand: 'show', positionals: ['completely-unrelated-name'] }),
      ),
    );
    expect(thrown).toBeUltimateError('X_DECLARATION_UNKNOWN');
    expect(thrown.fix).toBe('x tasks list --json');
  });

  test('a --count that is not a positive integer is a bad-flag error', async () => {
    registerNightlyPing();
    const thrown = await rejectedBy(() =>
      tasksCommand.run(
        contextFor(appRoot(), {
          subcommand: 'show',
          positionals: ['nightlyPing'],
          flags: { count: 'abc' },
        }),
      ),
    );
    expect(thrown).toBeUltimateError('X_CLI_BAD_FLAG');
  });
});

describe('unit · x tasks findings', () => {
  test('a module that will not import is a finding, and ok is false', async () => {
    const result = await tasksCommand.run(contextFor(brokenAppRoot(), { subcommand: 'list' }));
    expect(result.ok).toBe(false);
    expect(result.findings?.length).toBeGreaterThan(0);
    expect(result.findings?.[0]?.at).toBe('apps/web/app/broken.ts');
  });
});
