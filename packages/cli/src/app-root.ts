// Locating the app. `app.config.ts` is the one config file, so it is also the one root marker —
// commands that need an app resolve it here and nowhere else, and the failure names the fix.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BunVersionError, NotInAppError } from './errors';

export const APP_CONFIG_FILE = 'app.config.ts';
export const MANIFEST_FILE = 'x.manifest.json';
/**
 * The floor the shipped `x` enforces, and it must not sit below what `x` EMITS. It said `1.3.0`
 * through 2026-08-27 while `x test` spent `bun test --isolate` — a flag Bun introduced in
 * **1.3.13** — so a user on a Bun this file declared supported got an unknown-flag failure out of
 * the gate's dominant step, with `x doctor` reporting the runtime as fine. `--parallel` arrived in
 * the same release and is emitted now.
 *
 * `1.4.0` rather than `1.3.13` because a floor is a claim about a runtime somebody TESTED: CI pins
 * `1.4.x`, both images build on `oven/bun:1.4-*`, and the per-worker database rests on
 * `BUN_TEST_WORKER_ID`'s numbering, probed on 1.4.0 and on nothing older. `scripts/bun-pin.test.ts`
 * holds this to the same series as every other pin.
 */
export const REQUIRED_BUN = '1.4.0';

export interface AppRoot {
  readonly dir: string;
  readonly configPath: string;
  readonly manifestPath: string;
}

/** Walk up from `from` looking for `app.config.ts`. Returns undefined outside an app. */
export function findAppRoot(from: string): AppRoot | undefined {
  let dir = resolve(from);
  for (;;) {
    const configPath = join(dir, APP_CONFIG_FILE);
    if (existsSync(configPath)) {
      return { dir, configPath, manifestPath: join(dir, MANIFEST_FILE) };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function requireAppRoot(command: string, from: string): AppRoot {
  const root = findAppRoot(from);
  if (root === undefined) throw new NotInAppError({ command, from: resolve(from) });
  return root;
}

/** Semver-lite compare, sufficient because both sides are plain `major.minor.patch`. */
export function versionAtLeast(found: string, required: string): boolean {
  const parse = (input: string): readonly number[] =>
    input
      .split('-')[0]
      ?.split('.')
      .map((part) => Number.parseInt(part, 10) || 0) ?? [];
  const a = parse(found);
  const b = parse(required);
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

export function requireBunVersion(found: string, required: string = REQUIRED_BUN): void {
  if (!versionAtLeast(found, required)) throw new BunVersionError({ found, required });
}
