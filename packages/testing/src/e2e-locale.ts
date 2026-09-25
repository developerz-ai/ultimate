// The locale an e2e run's browser asks for: the app's own `defaultLocale`, read off `app.config.ts`
// the way the CLI reads its other boot facts. `@ultimat3/testing` sits below `@ultimat3/cli`, so the
// file name and the export name are restated here rather than imported from it.

import { join } from 'node:path'; // why: Bun ships no path join.

/** The app root's config module and the export holding the config — `x new` writes both. */
const APP_CONFIG_FILE = 'app.config.ts';
const APP_CONFIG_EXPORT = 'config';

/**
 * The app's `defaultLocale`, or `undefined` when it cannot be read — and then nothing is pinned.
 * Never a guessed `en`: pinning the wrong language would make every run photograph and assert on a
 * page no visitor at the unprefixed URL sees, which is worse than the runner's own Chrome locale.
 * The import runs the config module, which may validate an environment this process lacks.
 */
export async function e2eDefaultLocale(root: string): Promise<string | undefined> {
  const path = join(root, APP_CONFIG_FILE);
  if (!(await Bun.file(path).exists())) return undefined;
  let module: Record<string, unknown>;
  try {
    module = (await import(path)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const config = Object.hasOwn(module, APP_CONFIG_EXPORT) ? module[APP_CONFIG_EXPORT] : undefined;
  if (typeof config !== 'object' || config === null) return undefined;
  const locale = (config as Record<string, unknown>)['defaultLocale'];
  return typeof locale === 'string' && locale !== '' ? locale : undefined;
}
