// The first-hour run against a fake runner: the steps in a stranger's order, the published
// tarball named, a failed step recorded with its real time and every later step skipped, a tail
// that names the step that failed, and the work directory a run records and either keeps or
// removes.

import { describe, expect, test } from 'bun:test';
import type { Runner } from '@ultimat3/cli';
import { firstHourOk, firstHourSteps, runFirstHour } from './first-hour-run';

const input = { app: 'firsthour', work: '/work', version: '30.0.0', image: false };

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
      stdout: ok ? '' : 'X_TYPECHECK_FAILED',
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
      stdout: failed ? stdout : '',
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
      'setup after feature',
      'verify after feature',
    ]);
    expect(calls[0]).toEqual({
      command: 'bun x create-ultimate@30.0.0 firsthour --no-git',
      cwd: '/work',
    });
    expect(calls.slice(1).every((call) => call.cwd === '/work/firsthour')).toBe(true);
    expect(records.every((record) => record.status === 'ok' && record.ms === 1234)).toBe(true);
    expect(firstHourOk(records)).toBe(true);
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
        return { command, code: 0, ok: true, stdout: '', stderr: '', durationMs: 7 };
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
