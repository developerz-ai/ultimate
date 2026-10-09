// The command surface of `x tasks`: the spec, the table and summary `run()` renders, the `show`
// detail view, and the error paths — driven against `@ultimat3/jobs`'s real registries so a
// broken table column or a wrong fix line fails here, not just in `tasks-facts.test.ts`.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no path API: `mkdtempSync`/`tmpdir`/`join` are the only
// way to build the throwaway app root `requireAppRoot` has to find on disk.
// `mkdirSync`/`writeFileSync` stay with them because `Bun.write` is async and these run inside
// synchronous fixture helpers.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import {
  type JobDriver,
  job,
  memoryJobDriver,
  resetJobDriver,
  resetJobs,
  resetTasks,
  setJobDriver,
  t,
  task,
} from '@ultimat3/jobs';
import { REQUIRED_BUN } from './app-root';
import { tasksCommand } from './cmd-tasks';
import type { CommandContext } from './command';
import { msg } from './messages';
import type { ThrownShape } from './thrown-by-fixture';

/** Every temp dir this file makes, removed after it: a fixture that outlives its run is a leftover (#738). */
const madeDirs: string[] = [];
afterAll(() => {
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
/** Records a directory `mkdtemp` made, for the removal above. */
const made = (dir: string): string => {
  madeDirs.push(dir);
  return dir;
};

function appRoot(): string {
  const dir = made(mkdtempSync(join(tmpdir(), 'x-tasks-')));
  writeFileSync(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
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
  bunVersion: REQUIRED_BUN,
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
    // A ping touches no tenant-scoped table — the fixture exists to give a task a job to name.
    tenant: 'none' as const,
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

/**
 * The app's queue, already running — what `x tasks` finds inside `x dev`. Without one the command
 * boots the app's own (an embedded database: seconds per test), which `jobs-driver.ts` owns and
 * its own suite covers.
 */
let driver: JobDriver;
beforeEach(() => {
  driver = memoryJobDriver();
  setJobDriver(driver);
});

afterEach(() => {
  resetJobDriver();
  resetTasks();
  resetJobs();
});

/** The occurrence a day before `NEXT_MS`: what the scheduler last dispatched, in the fixture. */
const LAST_MS = Date.parse('2025-12-31T08:00:00Z');
const LAST_AT = '2025-12-31T03:00:00-05:00';

/** One rendered table line as its cells, from the jobs column on: `jobs`, `last`, `next`. */
const tailCells = (line: string | undefined): readonly string[] =>
  (line ?? '')
    .trim()
    .split(/\s{2,}/)
    .slice(4);

const recordFire = async (name: string, occurrenceMs: number): Promise<void> => {
  if (driver.introspect === undefined) expect.unreachable('the memory driver introspects');
  await driver.introspect.recordTaskFire({ task: name, occurrenceMs });
};

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
        // Never dispatched: three nulls, never an absent key — a reader of `--json` asks one way.
        lastMs: null,
        last: null,
        lastFiredAtMs: null,
      },
    ]);
    // And in the table the cell is `-`, in the column before `next`.
    expect((result.lines?.[0] ?? '').trim().split(/\s{2,}/)).toEqual([
      'name',
      'cron',
      'tz',
      'catchUp',
      'jobs',
      'last',
      'next',
    ]);
    expect(tailCells(row)).toEqual(['notify', '-', NEXT_AT]);
  });

  test('the last fire sits beside the next one, in the task’s own zone', async () => {
    registerNightlyPing();
    await recordFire('nightlyPing', LAST_MS);
    // A fire filed under a name no task carries any more is nobody's row.
    await recordFire('renamedAway', LAST_MS);
    const result = await tasksCommand.run(contextFor(appRoot(), { subcommand: 'list' }));
    const row = result.lines?.find((line) => line.includes('nightlyPing'));
    expect(tailCells(row)).toEqual(['notify', LAST_AT, NEXT_AT]);
    expect(result.data).toEqual([
      expect.objectContaining({
        name: 'nightlyPing',
        // The occurrence it was scheduled FOR — and when the scheduler dispatched it, on the
        // store's clock, which is the frozen one here.
        lastMs: LAST_MS,
        last: LAST_AT,
        lastFiredAtMs: NOW_MS,
        nextMs: NEXT_MS,
        next: NEXT_AT,
      }),
    ]);
  });

  test('an app that declares no task opens no queue at all', async () => {
    // A queue that answers would be a queue that was asked: this one refuses to be read.
    const base = memoryJobDriver();
    const introspect = base.introspect;
    if (introspect === undefined) expect.unreachable('the memory driver introspects');
    setJobDriver({
      ...base,
      introspect: {
        ...introspect,
        taskFires: () => expect.unreachable('x tasks read the queue with no task to join'),
      },
    });
    const result = await tasksCommand.run(contextFor(appRoot(), { subcommand: 'list' }));
    // (`ok` is the app's: a fixture root that declares nothing at all is `X_APP_EMPTY`.)
    expect(result.summary).toBe(msg('cli.tasks.count', { count: 0 }));
    expect(result.data).toEqual([]);
  });

  test('a driver with no introspection lists every task as never fired', async () => {
    registerNightlyPing();
    const { introspect: _none, ...bare } = memoryJobDriver();
    setJobDriver(bare);
    const result = await tasksCommand.run(contextFor(appRoot(), { subcommand: 'list' }));
    expect(result.data).toEqual([expect.objectContaining({ name: 'nightlyPing', lastMs: null })]);
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
    // `contextFor(root)` — the option ABSENT. `RunOptions.subcommand` is optional, so under
    // `exactOptionalPropertyTypes` an explicit `undefined` is a different statement; `contextFor`
    // reads `options.subcommand` with no default, so both produce the same `args.subcommand`.
    const viaUndefined = await tasksCommand.run(contextFor(root));
    expect(viaUndefined.summary).toBe(viaList.summary);
  });
});

describe('unit · x tasks show', () => {
  test('the descriptor, the last fire, the human phrase and count upcoming occurrences', async () => {
    registerNightlyPing();
    await recordFire('nightlyPing', LAST_MS);
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
    expect(result.lines).toContain(`  last: ${LAST_AT}`);
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
      lastMs: LAST_MS,
      last: LAST_AT,
      lastFiredAtMs: NOW_MS,
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
