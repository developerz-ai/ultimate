// Where an app lives, and where its `.x/` state goes. `app.config.ts` is the one root marker, so it
// is the one walk: a process started in a source folder (`bun test` from `apps/web/app/casos/`)
// still writes under the app root's `.x/`, never a `.x/cache` beside the code (#738).

// why: Bun has no synchronous existence check; the walk runs inside synchronous callers (Sass).
import { existsSync } from 'node:fs';
// why: Bun ships no path joiner.
import { dirname, join, resolve } from 'node:path';

export const APP_CONFIG_FILE = 'app.config.ts';

/** The app's own state directory, relative to its root: gitignored, a tmpfs in a container. */
export const APP_STATE_DIR = '.x';

/** Walk up from `from` to the nearest folder holding `app.config.ts`; undefined outside an app. */
export function appDirOf(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, APP_CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * `<app root>/.x/<parts>` for a process in `from` — the folder itself when no app is above it, as
 * a package's own test suite runs. The ONE way a framework module names a path under `.x/`.
 */
export const appStatePath = (from: string, ...parts: readonly string[]): string =>
  join(appDirOf(from) ?? resolve(from), APP_STATE_DIR, ...parts);
