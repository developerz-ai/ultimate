// The first-hour run against a fake runner: the steps in a stranger's order, the published
// tarball named, and a failed step recorded with its real time and every later step skipped.

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

  test('no step at all is not a first hour', () => {
    expect(firstHourOk([])).toBe(false);
  });
});

describe('unit · first-hour disk facts', () => {
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
