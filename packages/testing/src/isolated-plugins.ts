// Frees each finished test file in an ISOLATED run. Through Bun 1.4.5 a plugin keeps every
// finished file's global alive; Bun 1.4.6 clears it at the swap, so the workaround is skipped there.
// The framework registers two plugins in every file; `isolated-plugins.test.ts` measures both
// behaviours with real `bun test` runs.

import { afterAll } from 'bun:test';

/**
 * Set by `x test` (`@ultimat3/cli`'s `test-shards.ts`) on every `bun test` it spawns in isolated
 * mode. A preload cannot tell for itself: an isolated file sees the same argv, and a fresh process
 * and env are exactly what isolation looks like from inside.
 */
export const ISOLATED_ENV = 'ULTIMATE_TEST_ISOLATED';

/**
 * Bun 1.4.6 landed the runtime-side fix: the `--isolate` swap now clears the outgoing global's
 * plugin lists and module registry, and `Bun.plugin.clearAll()` shares that clear/reset path. The
 * framework's own `afterAll` clear then retains one global per file instead of freeing it. Canary
 * builds carry a `-canary` suffix, which semver orders BEFORE the 1.4.6 release, so compare the
 * numeric part only: the runtime fix is in every 1.4.6 build, prerelease or final. The hook below
 * is installed only while this returns true.
 */
export const needsPluginRelease = (version: string = Bun.version): boolean =>
  Bun.semver.order(version.split('-')[0] ?? version, '1.4.6') < 0;

/**
 * `Bun.plugin.clearAll()` after each file, isolated runs on Bun below 1.4.6 only. Measured on one
 * adopter's unit suite (652 files, 18 workers): per-worker peak 2.1–2.3 GB → 1.0–1.5 GB, total
 * ~30 GB → 18 GB. The next file's preload registers the plugins again, so every file still gets them.
 *
 * NEVER in a shared process: render's loader keeps an `installed` flag, so a cleared plugin is
 * never re-registered and the next `.tsx` compiles with Bun's classic factory — `__xh is not
 * defined`. On 1.4.6+ the runtime clears at the swap, so this installs no hook at all.
 */
export function releasePluginsAfterIsolatedFile(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
  after: (hook: () => void) => void = afterAll,
  plugin: { clearAll(): void } = Bun.plugin,
): boolean {
  if (env[ISOLATED_ENV] !== '1') return false;
  if (!needsPluginRelease()) return false;
  after(() => clearPlugins(plugin));
  return true;
}

/** Every `Bun.plugin` handler this process registered. The next file's preload registers them again. */
export const clearPlugins = (plugin: { clearAll(): void } = Bun.plugin): void => {
  plugin.clearAll();
};
