// An APP's tests compile every `.tsx` with the app's JSX factory from the first file on.
//
// Since 22.7 a worker runs many files in one module registry (no `--isolate`), so a `.tsx` module
// is compiled ONCE per worker and cached. `@ultimat3/render`'s loader is installed by importing
// `@ultimat3/render/server`; a file that reached a page component before any file had imported it
// cached the page compiled with Bun's classic factory, and every later file on that worker failed
// with `React is not defined` (18 notificado.co tests, measured). Installing the loader in the
// preload makes the first compile the right one.
//
// Only in an app (an `app.config.ts` at the run's root): the framework repository's own tests
// include suites that pin what a process WITHOUT the loader does, and they keep that process.

// why: Bun ships no synchronous file-exists check; Bun.file().exists() is async and a preload
// decides this before any test file loads.
import { existsSync } from 'node:fs';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';

export const APP_CONFIG = 'app.config.ts';

export const isAppRoot = (root: string = process.cwd()): boolean =>
  existsSync(join(root, APP_CONFIG));

/** Install the render loader when this run's root is an app. Returns whether it did. */
export async function installAppJsxLoader(root: string = process.cwd()): Promise<boolean> {
  if (!isAppRoot(root)) return false;
  const { installRenderLoader } = await import('@ultimat3/render/server');
  installRenderLoader();
  return true;
}
