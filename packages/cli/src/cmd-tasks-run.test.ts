// `x tasks run <name>`: a scheduled task fired now, through the task's own manual-run path — the
// jobs its occurrence would enqueue land on the app's queue, the result names each one, and a
// production environment asks for it by flag. Driven against `@ultimat3/jobs`' real registries.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API; `requireAppRoot` needs an app root on disk.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  type JobDriver,
  job,
  memoryJobDriver,
  resetJobs,
  resetTasks,
  t,
  task,
} from '@ultimat3/jobs';
import { installJobDriver, resetJobDriver } from '@ultimat3/jobs/adapter';
import { REQUIRED_BUN } from './app-root';
import { tasksCommand } from './cmd-tasks';
import type { CommandContext } from './command';
import { msg } from './messages';
import type { ThrownShape } from './thrown-by-fixture';

const madeDirs: string[] = [];
afterAll(() => {
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function appRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'x-tasks-run-'));
  madeDirs.push(dir);
  writeFileSync(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  return dir;
}

const contextFor = (
  root: string,
  positionals: readonly string[],
  options: { readonly flags?: Record<string, boolean>; readonly env?: Record<string, string> } = {},
): CommandContext => ({
  args: {
    command: 'tasks',
    subcommand: 'run',
    positionals: [...positionals],
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

async function rejectedBy(call: () => Promise<unknown>): Promise<ThrownShape> {
  try {
    await call();
  } catch (error) {
    return error as ThrownShape;
  }
  return expect.unreachable('expected a rejection');
}

/** A task whose occurrence enqueues one job per org it names: the fan-out a digest is. */
function registerDigest(): void {
  const digest = job({
    name: 'sendDigest',
    input: t.object({ org: t.string }),
    tenant: 'none' as const,
    idempotencyKey: (input) => input.org,
    retry: { attempts: 1 },
    run: () => Promise.resolve(),
  });
  task({
    name: 'nightlyDigest',
    cron: '0 3 * * *',
    tz: 'UTC',
    enqueue: () => [
      [digest, { org: 'a' }],
      [digest, { org: 'b' }],
    ],
  });
}

let driver: JobDriver;
beforeEach(() => {
  driver = memoryJobDriver();
  installJobDriver(driver);
});

afterEach(() => {
  resetJobDriver();
  resetTasks();
  resetJobs();
});

describe('unit · x tasks run', () => {
  test('is a declared subcommand, and --production is read by it alone', () => {
    expect(tasksCommand.spec.subcommands).toContain('run');
    const flag = tasksCommand.spec.flags?.find((one) => one.name === 'production');
    expect(flag?.type).toBe('boolean');
    expect(flag?.subcommands).toEqual(['run']);
  });

  test('fires the task now: each job its occurrence enqueues is on the queue', async () => {
    registerDigest();
    const result = await tasksCommand.run(contextFor(appRoot(), ['nightlyDigest']));
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(msg('cli.tasks.ran', { name: 'nightlyDigest', count: 2 }));
    const queued = await driver.introspect?.list({ name: 'sendDigest' });
    expect(queued?.map((row) => row.input)).toEqual(
      expect.arrayContaining([{ org: 'a' }, { org: 'b' }]),
    );
    expect(queued).toHaveLength(2);
    const data = result.data as { task: string; jobs: { job: string; deduped: boolean }[] };
    expect(data.task).toBe('nightlyDigest');
    expect(data.jobs.map((one) => [one.job, one.deduped])).toEqual([
      ['sendDigest', false],
      ['sendDigest', false],
    ]);
  });

  test('a name no task carries is refused with the nearest one', async () => {
    registerDigest();
    const thrown = await rejectedBy(() =>
      tasksCommand.run(contextFor(appRoot(), ['nightlyDigst'])),
    );
    expect(thrown.code).toBe('X_DECLARATION_UNKNOWN');
    expect(String(thrown.fix)).toContain('nightlyDigest');
    expect(await driver.introspect?.list({})).toEqual([]);
  });

  test('no name is refused with the command that lists them', async () => {
    const thrown = await rejectedBy(() => tasksCommand.run(contextFor(appRoot(), [])));
    expect(thrown.code).toBe('X_CLI_BAD_FLAG');
    expect(thrown.cause).toContain('x tasks run <name> needs a task name');
    expect(thrown.fix).toBe('x tasks list --json');
  });

  test('production fires only when asked by flag, and nothing is queued before it is', async () => {
    registerDigest();
    const env = { ULTIMATE_ENV: 'production' };
    const thrown = await rejectedBy(() =>
      tasksCommand.run(contextFor(appRoot(), ['nightlyDigest'], { env })),
    );
    expect(thrown.code).toBe('X_CLI_BAD_FLAG');
    expect(thrown.cause).toContain('production');
    expect(thrown.fix).toBe('x tasks run nightlyDigest --production --json');
    expect(await driver.introspect?.list({})).toEqual([]);
    const asked = await tasksCommand.run(
      contextFor(appRoot(), ['nightlyDigest'], { env, flags: { production: true } }),
    );
    expect(asked.ok).toBe(true);
    expect(await driver.introspect?.list({})).toHaveLength(2);
  });
});
