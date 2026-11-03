// `x g` formats the source it just wrote. Templates are pre-formatted (`generate-format.test.ts`
// holds them to it), and a template is a string with its line breaks typed by hand, for every name
// an app can pick: a name long enough to wrap a line none of those runs named landed in an app
// whose first `lint` was then red over code nobody typed. The app's own Biome, under its own config.

import { existsSync } from 'node:fs'; // why: a synchronous file probe; Bun.file answers asynchronously.
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { Runner } from './exec';

const SOURCE = /\.tsx?$/;

/**
 * Best effort, and that is the whole contract: the files are already on disk and correct, this only
 * re-wraps them. A binary the app has not installed, a config it has not written or a version that
 * refuses them must not turn `x g` red over a file the `lint` step would have reported anyway, so
 * the verdict is left for that step. The app's own binary or none: `bunx` would download one.
 */
export async function formatWritten(
  root: string,
  written: readonly string[],
  runner: Runner,
): Promise<void> {
  const sources = written.filter((path) => SOURCE.test(path));
  if (sources.length === 0) return;
  if (!['biome.json', 'biome.jsonc'].some((config) => existsSync(join(root, config)))) return;
  const biome = Bun.which('biome', { PATH: join(root, 'node_modules', '.bin') });
  if (biome === null) return;
  await runner([biome, 'check', '--write', '--files-ignore-unknown=true', ...sources], {
    cwd: root,
  });
}
