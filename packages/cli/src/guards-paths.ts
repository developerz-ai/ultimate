// Where an app's own guards are, as a leaf: the `guards/` directory and its files. Read by the gate
// (`guards.ts`), `x doctor` and the manifest's error-code projection, the last on the serving
// roles' graph — so nothing here imports a template or a runner.

// Bun ships no equivalent for either: `existsSync` answers whether this app has a guards
// directory, `join` builds the host-separator path.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The directory IS the registration. An app-side list is a list an app can forget to add to. */
export const GUARD_DIR = 'guards';

/**
 * Every guard file, app-root-relative and sorted, so two machines report the same findings in the
 * same order. A `*.test.ts` beside a guard is its test, never a second guard — the generator emits
 * one, and importing it would run the suite inside the gate.
 */
export async function guardPaths(root: string): Promise<readonly string[]> {
  const dir = join(root, GUARD_DIR);
  if (!existsSync(dir)) return [];
  const paths: string[] = [];
  for await (const entry of new Bun.Glob('*.{ts,tsx}').scan({ cwd: dir, absolute: false })) {
    const path = entry.split('\\').join('/');
    if (/\.(?:test|d)\.tsx?$/.test(path)) continue;
    paths.push(`${GUARD_DIR}/${path}`);
  }
  return paths.sort();
}
