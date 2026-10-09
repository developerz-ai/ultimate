// Locating the app. `app.config.ts` is the one config file, so it is also the one root marker —
// commands that need an app resolve it here and nowhere else, and the failure names the fix.

import { join, resolve } from 'node:path';
import { APP_CONFIG_FILE, appDirOf } from '@ultimat3/core';
import { BunVersionError, NotInAppError } from './errors';

/**
 * The one file `defineApi` is called from in a scaffolded app — here, beside the config file, so
 * the module scan can import it first without pulling the generators into the serve graph.
 */
export const API_INDEX = 'apps/web/api/index.ts';
export const MANIFEST_FILE = 'x.manifest.json';
/**
 * The floor the shipped `x` enforces, and it must not sit below what `x` EMITS. It said `1.3.0`
 * through 2026-08-27 while `x test` spent `bun test --isolate` — a flag Bun introduced in
 * **1.3.13** — so a user on a Bun this file declared supported got an unknown-flag failure out of
 * the gate's dominant step, with `x doctor` reporting the runtime as fine. `--parallel` arrived in
 * the same release and is emitted now, so the floor may never fall below that patch.
 *
 * A 1.4 patch rather than `1.3.13` because a floor is a claim about a runtime somebody TESTED: CI
 * pins one exact patch, both images build on that patch's `oven/bun:1.4-*` digest, and the
 * per-worker database rests on `BUN_TEST_WORKER_ID`'s numbering, probed on 1.4 and on nothing older.
 * It moved 1.4.0 → 1.4.2 with CI's pin (plan 2026/10/04/101, sweep 3): from then on 1.4.0 was a
 * runtime nothing here ran, and the bundler defects fixed in 1.4.1 (oven-sh/bun#40578, #40650,
 * #40657) change what `x build` emits. `scaffold-repo.ts` and the scaffold's CI read this constant,
 * so a new app's `engines.bun` and its CI runtime move with it. `scripts/bun-pin.test.ts` holds it
 * to the exact patch CI runs.
 *
 * **Lowering it to 1.3.14 was tried on 2026-08-27 and refused**, and the argument for trying was
 * sound — `--isolate` and `--parallel` are 1.3.13 features, no package here calls a 1.4-only API
 * (`bun run typecheck` is clean against `@types/bun@1.3.14`), and `>=1.4.0` therefore bars Bun 1.3
 * users for a capability the framework does not use. What refused it is a Bun 1.3.14 defect, not
 * the paperwork: a service shutdown against a destroyed database never resolves there
 * (`queue.stop()`, reproduced by `runtime-services.live.test.ts`), so an app on a runtime this line
 * declared supported would hang on graceful shutdown the moment its database went away. The full
 * measurement is in `.github/actions/setup/action.yml`; read it before lowering this.
 */
export const REQUIRED_BUN = '1.4.2';

export interface AppRoot {
  readonly dir: string;
  readonly configPath: string;
  readonly manifestPath: string;
}

/** Walk up from `from` looking for `app.config.ts` (core's `appDirOf`). Undefined outside an app. */
export function findAppRoot(from: string): AppRoot | undefined {
  const dir = appDirOf(from);
  return dir === undefined
    ? undefined
    : { dir, configPath: join(dir, APP_CONFIG_FILE), manifestPath: join(dir, MANIFEST_FILE) };
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
