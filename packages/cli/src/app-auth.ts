// The one fact `x dev` and `serve.ts` need out of `app.config.ts` before a listener binds: where
// this app's sign-in page is. Sibling of `app-env.ts`'s `loadEnvSchema`, and imports the config
// for the same reason — a regex over the app's source is the pattern `app-load.ts` refuses.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_CONFIG_FILE } from './app-root';

/** The export every app declares. Named, never default — the CLI and the runtime both import it. */
export const APP_CONFIG_EXPORT = 'config';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * `auth.signInPath`, or `null` when the app declares none.
 *
 * Structural, not `instanceof`: `defineConfig` returns a plain object, and a config that resolved
 * through an older version of core simply has no `auth` section. `null` is the safe answer either
 * way — it is what turns the browser redirect off and leaves the problem document in place.
 */
export async function loadSignInPath(root: string): Promise<string | null> {
  const configPath = join(root, APP_CONFIG_FILE);
  if (!existsSync(configPath)) return null;
  const module = (await import(configPath)) as Record<string, unknown>;
  const config = module[APP_CONFIG_EXPORT];
  if (!isRecord(config)) return null;
  const auth = config['auth'];
  if (!isRecord(auth)) return null;
  const path = auth['signInPath'];
  return typeof path === 'string' && path.startsWith('/') ? path : null;
}
