// Frees each finished test file in an ISOLATED run. Bun 1.4.0 keeps every finished file's global
// object — its module graph, PGlite heap and fakes — alive under `--isolate` (implied by
// `--parallel`) once any `Bun.plugin` load/resolve handler is registered, and the framework
// registers two in every file. `isolated-plugins.test.ts` measures it with real `bun test` runs.

import { afterAll } from 'bun:test';

/**
 * Set by `x test` (`@ultimat3/cli`'s `test-shards.ts`) on every `bun test` it spawns in isolated
 * mode. A preload cannot tell for itself: an isolated file sees the same argv, and a fresh process
 * and env are exactly what isolation looks like from inside.
 */
export const ISOLATED_ENV = 'ULTIMATE_TEST_ISOLATED';

/**
 * `Bun.plugin.clearAll()` after each file, isolated runs only. Measured on notificado.co's unit
 * suite (652 files, 18 workers): per-worker peak 2.1–2.3 GB → 1.0–1.5 GB, total ~30 GB → 18 GB. The
 * next file's preload registers the plugins again, so every file still gets them.
 *
 * NEVER in a shared process: render's loader keeps an `installed` flag, so a cleared plugin is
 * never re-registered and the next `.tsx` compiles with Bun's classic factory — `__xh is not
 * defined`.
 */
export function releasePluginsAfterIsolatedFile(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
  after: (hook: () => void) => void = afterAll,
  plugin: { clearAll(): void } = Bun.plugin,
): boolean {
  if (env[ISOLATED_ENV] !== '1') return false;
  after(() => clearPlugins(plugin));
  return true;
}

/** Every `Bun.plugin` handler this process registered. The next file's preload registers them again. */
export const clearPlugins = (plugin: { clearAll(): void } = Bun.plugin): void => {
  plugin.clearAll();
};
