// `x test e2e` runs the e2e suite the way the gate's `e2e` step does: in an app root, with a
// browser on the machine, under `@ultimat3/testing`'s e2e preload with the app root and the device
// zone named — the preload spawns the app and the browser-backed cases run. Without it every one of
// them skipped, so `x test e2e` was green having opened no browser.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no mkdtemp or recursive remove.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; // why: Bun exposes no temp-directory root.
import { join } from 'node:path'; // why: Bun exposes no path-join primitive.
import { APP_CONFIG_FILE } from '@ultimat3/core';
import { CHROME_PATH_ENV } from '@ultimat3/scraping/cdp';
import { E2E_ROOT_ENV } from '@ultimat3/testing';
import type { ExecOptions, Runner } from './exec';
import { runShards } from './test-shards';
import { E2E_TIME_ZONE, e2ePreload } from './verify-e2e';

interface Call {
  readonly command: readonly string[];
  readonly env: ExecOptions['env'];
}

const recorder = (): { calls: Call[]; runner: Runner } => {
  const calls: Call[] = [];
  const runner: Runner = async (command, options) => {
    calls.push({ command, env: options.env });
    return { command, code: 0, ok: true, stdout: '', stderr: '', durationMs: 1 };
  };
  return { calls, runner };
};

const roots: string[] = [];
const root = (app: boolean): string => {
  const dir = mkdtempSync(join(tmpdir(), 'x-test-e2e-'));
  roots.push(dir);
  if (app) writeFileSync(join(dir, APP_CONFIG_FILE), 'export default {};\n');
  return dir;
};

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const FILES = [
  { path: 'e2e/home.e2e.test.ts', bytes: 100 },
  { path: 'apps/web/a.test.ts', bytes: 100 },
];

/** A browser `findChrome` accepts: a declared `CHROME_PATH` that exists. */
const withBrowser = { ...Bun.env, [CHROME_PATH_ENV]: process.execPath };
/** A declared `CHROME_PATH` that names nothing: inside the run's own root, never a shared one. */
const noBrowser = (dir: string) => ({
  ...Bun.env,
  [CHROME_PATH_ENV]: join(dir, 'no-such-browser'),
});

const run = async (dir: string, env: Readonly<Record<string, string | undefined>>) => {
  const { calls, runner } = recorder();
  await runShards({ root: dir, runner, env, files: FILES, workers: 2 });
  const e2e = calls.find((call) => call.command.includes('e2e/home.e2e.test.ts'));
  const unit = calls.find((call) => call.command.includes('apps/web/a.test.ts'));
  return { e2e, unit };
};

describe('x test: the e2e pass drives a browser, as the gate does', () => {
  test('an app with a browser: the e2e pass runs under the preload, root and zone named', async () => {
    const dir = root(true);
    const { e2e, unit } = await run(dir, withBrowser);
    expect(e2e?.command.slice(0, 4)).toEqual(['bun', 'test', '--preload', e2ePreload()]);
    expect(e2e?.env?.[E2E_ROOT_ENV]).toBe(dir);
    expect(e2e?.env?.['TZ']).toBe(E2E_TIME_ZONE);
    // The other pass is untouched: no app spawned beside a unit run.
    expect(unit?.command).not.toContain('--preload');
    expect(unit?.env?.[E2E_ROOT_ENV]).toBeUndefined();
  });

  test('no browser: the suite runs as before, its browser cases skipping', async () => {
    const dir = root(true);
    const { e2e } = await run(dir, noBrowser(dir));
    expect(e2e?.command).not.toContain('--preload');
    expect(e2e?.env?.[E2E_ROOT_ENV]).toBeUndefined();
  });

  test('not an app: nothing to spawn, so no preload', async () => {
    const { e2e } = await run(root(false), withBrowser);
    expect(e2e?.command).not.toContain('--preload');
  });
});
