// Whether this test run's root is an APP — an `app.config.ts` beside it. The registry leak guard
// restores an app's lazily declared registries as a union, and the framework's own suites exactly.

// why: Bun ships no synchronous file-exists check; Bun.file().exists() is async and a preload
// decides this before any test file loads.
import { existsSync } from 'node:fs';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';

export const APP_CONFIG = 'app.config.ts';

export const isAppRoot = (root: string = process.cwd()): boolean =>
  existsSync(join(root, APP_CONFIG));
