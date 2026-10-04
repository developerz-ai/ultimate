// The one fact `x dev` and `serve.ts` need out of `app.config.ts` before a listener binds: where
// this app's sign-in page is, off the one loader (`app-config-load.ts`).

import { loadAppConfig } from './app-config-load';

/** `auth.signInPath`, or `null` when the app declares none or the root has no config file. */
export async function loadSignInPath(root: string): Promise<string | null> {
  return (await loadAppConfig(root))?.auth.signInPath ?? null;
}
