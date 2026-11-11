// The first-hour run against a fake runner: the steps in a stranger's order, the published
// tarball named, a failed step recorded with its real time and every later step skipped, a tail
// that names the step that failed, and the work directory a run records and either keeps or
// removes.

import { describe, expect, test } from 'bun:test';
import type { Runner } from '@ultimat3/cli';
import { firstHourOk, firstHourSteps, runFirstHour } from './first-hour-run';

const input = { app: 'firsthour', work: '/work', version: '30.0.0', image: false };

/**
 * What `x g resource note --json` prints on a clean run: the verdict, carrying the commands its
 * author is told to run next (`nextSteps()` in `packages/cli/src/cmd-generate.ts`).
 */
const FEATURE_VERDICT = JSON.stringify({
  ok: true,
  command: 'g',
  data: { next: ['bunx x db gen "create notes"', 'bunx x db migrate'] },
});

/** The stdout a fake answers `command` with: the generator's verdict for the feature step. */
const stdoutOf = (line: string): string => (line.includes(' g resource ') ? FEATURE_VERDICT : '');

/** Answers every command `ok`, except one whose first word set includes `failing`. */
const runner =
  (calls: { command: string; cwd: string }[], failing?: string): Runner =>
  async (command, options) => {
    const line = command.join(' ');
    calls.push({ command: line, cwd: options.cwd });
    const ok = failing === undefined || !line.includes(failing);
    return {
      command,
      code: ok ? 0 : 1,
      ok,
      stdout: ok ? stdoutOf(line) : 'X_TYPECHECK_FAILED',
      stderr: '',
      durationMs: 1234.4,
    };
  };

/** One gate heartbeat, exactly as `verify-progress.ts` writes it to stderr. */
const heartbeat = (name: string, ok: boolean): string => `{"step":"${name}","ok":${ok},"ms":12}`;

/**
 * A runner where every step passes except `bun run verify --json`, which answers with the output a
 * red gate really leaves: the `--json` verdict on stdout, one heartbeat line per step on stderr.
 */
const redGate =
  (stdout: string, stderr: string): Runner =>
  async (command) => {
    const failed = command.join(' ').includes('verify --json');
    return {
      command,
      code: failed ? 1 : 0,
      ok: !failed,
      stdout: failed ? stdout : stdoutOf(command.join(' ')),
      stderr: failed ? stderr : '',
      durationMs: 1,
    };
  };

describe('unit · first-hour', () => {
  test('the steps run in a stranger’s order, from the published tarball', async () => {
    const calls: { command: string; cwd: string }[] = [];
    const records = await runFirstHour(input, runner(calls), {});
    expect(records.map((record) => record.name)).toEqual([
      'scaffold',
      'setup',
      'verify',
      'first feature',
      'feature next steps',
      'setup after feature',
      'verify after feature',
    ]);
    expect(calls[0]).toEqual({
      command: 'bun x create-ultimate@30.0.0 firsthour --no-git',
      cwd: '/work',
    });
    expect(calls.slice(1).every((call) => call.cwd === '/work/firsthour')).toBe(true);
    expect(records.every((record) => record.status === 'ok')).toBe(true);
    expect(firstHourOk(records)).toBe(true);
  });

  test('the generator’s own next commands run before the gate — x db gen included', async () => {
    // Run 42879568783: the bench went from `x g resource note` straight to the gate, skipping the
    // `x db gen` the generator printed, and `unit`, `exercise` and `drift` were red on `notes`.
    const calls: { command: string; cwd: string }[] = [];
    const records = await runFirstHour(input, runner(calls), {});
    expect(calls.map((call) => call.command).slice(3)).toEqual([
      'bun x x g resource note --json',
      'bun x x db gen create notes',
      'bun x x db migrate',
      'bun run setup',
      'bun run verify --json',
    ]);
    // One record for the list, timed as their sum, under the commands as printed.
    expect(records.find((record) => record.name === 'feature next steps')).toEqual({
      name: 'feature next steps',
      command: 'bun x x db gen create notes && bun x x db migrate',
      ms: 2469,
      status: 'ok',
    });
  });

  test('a red next command fails the step under its own name; the gate never runs', async () => {
    const records = await runFirstHour(input, runner([], 'db gen'), {});
    expect(records.find((record) => record.name === 'feature next steps')).toEqual(
      expect.objectContaining({
        status: 'failed',
        command: 'bun x x db gen create notes',
        tail: 'X_TYPECHECK_FAILED',
      }),
    );
    expect(records.at(-1)).toEqual(expect.objectContaining({ status: 'skipped', ms: null }));
  });

  test('a feature whose verdict cannot be read is a failure, never "nothing to run"', async () => {
    const plain: Runner = async (command) => ({
      command,
      code: 0,
      ok: true,
      stdout: command.join(' ').includes(' g resource ') ? '✓ wrote 40 file(s)' : '',
      stderr: '',
      durationMs: 1,
    });
    const records = await runFirstHour(input, plain, {});
    expect(records.find((record) => record.name === 'feature next steps')).toEqual(
      expect.objectContaining({ status: 'failed', ms: 0 }),
    );
    expect(firstHourOk(records)).toBe(false);
  });

  test('a failed step keeps its real time and its output; every later step is skipped, untimed', async () => {
    const records = await runFirstHour(input, runner([], 'verify --json'), {});
    const verify = records.find((record) => record.name === 'verify');
    expect(verify).toEqual(
      expect.objectContaining({ status: 'failed', ms: 1234, tail: 'X_TYPECHECK_FAILED' }),
    );
    const after = records.slice(records.findIndex((record) => record.name === 'verify') + 1);
    expect(after.length).toBeGreaterThan(0);
    for (const record of after)
      expect(record).toEqual(expect.objectContaining({ status: 'skipped', ms: null }));
    expect(firstHourOk(records)).toBe(false);
  });

  test('--image adds the container build last, and only then', () => {
    expect(firstHourSteps(input).some((step) => step.name === 'image')).toBe(false);
    expect(
      firstHourSteps({ ...input, image: true })
        .at(-1)
        ?.command.slice(0, 2),
    ).toEqual(['docker', 'build']);
  });

  test('a red gate names the step that failed, not the five that printed after it', async () => {
    // The gate's own shape: a `--json` verdict on stdout, one heartbeat per step on stderr — so the
    // last lines of the merge belong to the steps that finished LAST, and a plain tail of five
    // would report `seo | i18n | policy | budgets | roadmap` and never the step that went red.
    const heartbeats = [
      heartbeat('manifest', false),
      heartbeat('seo', true),
      heartbeat('i18n', true),
      heartbeat('policy', true),
      heartbeat('budgets', true),
      heartbeat('roadmap', true),
    ];
    const records = await runFirstHour(
      input,
      redGate('{\n  "ok": false,\n  "summary": "the gate is red"\n}', heartbeats.join('\n')),
      {},
    );
    expect(records.find((record) => record.name === 'verify')?.tail).toBe(heartbeats.join(' | '));
  });

  test('a step that failed last is named once, not twice', async () => {
    const late = [
      heartbeat('seo', true),
      heartbeat('i18n', true),
      heartbeat('policy', true),
      heartbeat('budgets', true),
      heartbeat('manifest', false),
    ].join('\n');
    const records = await runFirstHour(input, redGate('', late), {});
    expect(records.find((record) => record.name === 'verify')?.tail).toBe(
      [
        heartbeat('manifest', false),
        heartbeat('seo', true),
        heartbeat('i18n', true),
        heartbeat('policy', true),
        heartbeat('budgets', true),
      ].join(' | '),
    );
  });

  test('a heartbeat line that is not valid JSON is output, never a verdict', async () => {
    const records = await runFirstHour(
      input,
      redGate('', `{"step":"manifest","ok":false\n${heartbeat('seo', true)}`),
      {},
    );
    expect(records.find((record) => record.name === 'verify')?.tail).toBe(
      `{"step":"manifest","ok":false | ${heartbeat('seo', true)}`,
    );
  });

  test('no step at all is not a first hour', () => {
    expect(firstHourOk([])).toBe(false);
  });
});

describe('unit · first-hour disk facts', () => {
  test('a kept run leaves the scaffold its record points at, and every other run loses its tree', async () => {
    // why: Bun has no temp-directory or recursive-remove API; `node:fs` owns the throwaway tree.
    const { existsSync, mkdirSync, rmSync, statSync } = await import('node:fs');
    // why: Bun exposes no path-join primitive.
    const { join } = await import('node:path');
    const { oneRun } = await import('./first-hour');

    /**
     * The published scaffold, faked: `create-ultimate` makes the app directory in the clean `work`,
     * every later step only answers. Anything else it is asked is a command this fake cannot run.
     */
    const scaffolder =
      (calls: { command: string; cwd: string }[]): Runner =>
      async (command, options) => {
        const line = command.join(' ');
        calls.push({ command: line, cwd: options.cwd });
        if (line.includes('create-ultimate'))
          mkdirSync(join(options.cwd, 'firsthour'), { recursive: true });
        return { command, code: 0, ok: true, stdout: stdoutOf(line), stderr: '', durationMs: 7 };
      };

    const calls: { command: string; cwd: string }[] = [];
    const kept = await oneRun('30.0.0', false, { keep: true, runner: scaffolder(calls) });
    try {
      // `.runs[-1].work` plus the `/firsthour` bench.yml appends is the scaffold it must mount.
      expect(calls[0]).toEqual({
        command: 'bun x create-ultimate@30.0.0 firsthour --no-git',
        cwd: kept.work,
      });
      expect(existsSync(kept.work)).toBe(true);
      expect(statSync(join(kept.work, 'firsthour')).isDirectory()).toBe(true);
      // The hour ran on the injected runner, not on the real `exec` this machine must not call.
      expect(firstHourOk(kept.steps)).toBe(true);
    } finally {
      rmSync(kept.work, { recursive: true, force: true });
    }

    const dropped = await oneRun('30.0.0', false, { runner: scaffolder([]) });
    try {
      expect(existsSync(dropped.work)).toBe(false);
    } finally {
      rmSync(dropped.work, { recursive: true, force: true });
    }
  });

  test('no step sees a secret of the parent’s env — every one is unset for exec’s merge', async () => {
    // why: Bun has no recursive-remove API; `node:fs` owns the throwaway tree.
    const { mkdirSync, rmSync } = await import('node:fs');
    // why: Bun exposes no path-join primitive.
    const { join } = await import('node:path');
    const { oneRun } = await import('./first-hour');
    const envs: Readonly<Record<string, string | undefined>>[] = [];
    const capture: Runner = async (command, options) => {
      envs.push(options.env ?? {});
      if (command.join(' ').includes('create-ultimate'))
        mkdirSync(join(options.cwd, 'firsthour'), { recursive: true });
      const stdout = stdoutOf(command.join(' '));
      return { command, code: 0, ok: true, stdout, stderr: '', durationMs: 1 };
    };
    const parentEnv = { PATH: '/usr/bin', NPM_TOKEN: 'x', NPM_TOTP_SECRET: 'x', HOME: '/me' };
    const run = await oneRun('30.0.0', false, { runner: capture, parentEnv });
    rmSync(run.work, { recursive: true, force: true });
    // Every step's command, and the generator's next one twice: `db gen` and `db migrate`.
    expect(envs.length).toBe(run.steps.length + 1);
    for (const env of envs) {
      expect('NPM_TOKEN' in env && env['NPM_TOKEN'] === undefined).toBe(true);
      expect('NPM_TOTP_SECRET' in env && env['NPM_TOTP_SECRET'] === undefined).toBe(true);
      expect(env['PATH']).toBe('/usr/bin');
      expect(env['HOME']).toBe(join(run.work, 'home'));
      expect(env['NPM_CONFIG_USERCONFIG']).toBeDefined();
    }
  });

  test('of three runs, only the last keeps its tree — the one bench.yml mounts', async () => {
    // why: Bun has no recursive-remove or existence-check API; `node:fs` owns the throwaway tree.
    const { existsSync, mkdirSync, rmSync } = await import('node:fs');
    // why: Bun exposes no path-join primitive.
    const { join } = await import('node:path');
    const { runAll } = await import('./first-hour');

    /** Same fake scaffold as above: `create-ultimate` makes the app directory, nothing else runs. */
    const scaffolder = (): Runner => async (command, options) => {
      if (command.join(' ').includes('create-ultimate'))
        mkdirSync(join(options.cwd, 'firsthour'), { recursive: true });
      return { command, code: 0, ok: true, stdout: '', stderr: '', durationMs: 7 };
    };

    const runs = await runAll(3, '30.0.0', false, scaffolder());
    try {
      expect(runs).toHaveLength(3);
      expect(runs.map((run) => existsSync(run.work))).toEqual([false, false, true]);
    } finally {
      for (const run of runs) rmSync(run.work, { recursive: true, force: true });
    }
  });

  test('a symlink loop is not followed, and a hard link is counted once — as du counts', async () => {
    // why: Bun has no temp-directory, link or symlink API; `node:fs` owns the throwaway tree.
    const { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import(
      'node:fs'
    );
    // why: Bun exposes no tmpdir(); only `node:os` answers the platform temp root.
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(`${tmpdir()}/first-hour-test-`);
    try {
      mkdirSync(`${root}/app/node_modules/pkg`, { recursive: true });
      mkdirSync(`${root}/app/.x`);
      writeFileSync(`${root}/app/README.md`, 'abc');
      writeFileSync(`${root}/app/.x/state`, 'ignored');
      writeFileSync(`${root}/app/node_modules/pkg/index.js`, '12345');
      linkSync(`${root}/app/node_modules/pkg/index.js`, `${root}/app/node_modules/pkg/copy.js`);
      symlinkSync('..', `${root}/app/node_modules/pkg/loop`);
      const { bytesUnder, appFiles } = await import('./first-hour');
      expect(appFiles(`${root}/app`)).toBe(1);
      expect(bytesUnder(`${root}/app/node_modules`)).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
