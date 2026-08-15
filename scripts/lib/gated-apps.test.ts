// The pin table is data, and these are the invariants that keep it honest: no pin for a step the
// gate cannot report, no anonymous pin, no pin for an app that no longer exists — and, the one
// this file exists for, no app in the repo that the gate does not run at all.

import { describe, expect, test } from 'bun:test';
// Both `node:`-only by necessity: Bun exposes no path-join primitive, and its only existence check
// (`Bun.file().exists()`) is async — these assertions sit in synchronous `test()` bodies, where an
// unawaited promise is a passing test that checked nothing.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { VERIFY_STEP_NAMES } from '@ultimat3/cli';
import { GATED_APPS, PINS_FILE } from './gated-apps';
import { repoRoot } from './run';

/**
 * Every app this repo tracks, read off the root package.json rather than hardcoded: an app root is
 * a `<top>/*` workspace pattern that is not `packages/*`. Adding `demos/*` to that list therefore
 * puts every demo under the same rule without touching this test.
 */
const trackedApps = async (root: string): Promise<readonly string[]> => {
  const manifest = (await Bun.file(join(root, 'package.json')).json()) as {
    readonly workspaces?: readonly string[];
  };
  const dirs: string[] = [];
  for (const pattern of manifest.workspaces ?? []) {
    if (!/^[^/*]+\/\*$/.test(pattern) || pattern === 'packages/*') continue;
    for await (const found of new Bun.Glob(`${pattern}/package.json`).scan({
      cwd: root,
      absolute: false,
    })) {
      dirs.push(found.split('/').slice(0, -1).join('/'));
    }
  }
  return dirs.sort();
};

describe('GATED_APPS', () => {
  test('every app in the repo is gated — a tracked app with no ratchet is a claim nobody checks', async () => {
    const root = repoRoot();
    const gated = GATED_APPS.map((app) => app.dir).sort();
    expect(await trackedApps(root)).toEqual(gated);
  });

  test('the deployed demo is one of them', () => {
    // Named, not just counted: .github/workflows/deploy-social-demo.yml publishes this app's image
    // on every push to main, and it spent its whole life outside every verify path.
    expect(GATED_APPS.map((app) => app.dir)).toContain('dummy/social-media-clone');
  });

  test('each app is a real directory, so a pin cannot outlive the app it excuses', () => {
    for (const app of GATED_APPS) {
      expect(existsSync(join(repoRoot(), app.dir, 'package.json'))).toBe(true);
    }
  });

  test('no app is listed twice, and its build-graph entry matches its directory', () => {
    const dirs = GATED_APPS.map((app) => app.dir);
    expect(new Set(dirs).size).toBe(dirs.length);
    for (const app of GATED_APPS) expect(app.reference).toBe(`./${app.dir}`);
  });

  test('every pinned step name is one the gate can actually report', () => {
    const names: readonly string[] = VERIFY_STEP_NAMES;
    for (const app of GATED_APPS) {
      for (const name of Object.keys(app.expectedRed)) expect(names).toContain(name);
    }
  });

  test('every pin states who owns it, so the table cannot grow anonymous entries', () => {
    for (const app of GATED_APPS) {
      for (const reason of Object.values(app.expectedRed)) {
        expect(reason.length).toBeGreaterThan(20);
      }
    }
  });

  test('PINS_FILE points at this file, so the stale-pin fix names somewhere real', () => {
    expect(existsSync(join(repoRoot(), PINS_FILE))).toBe(true);
  });
});
