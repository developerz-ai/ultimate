// The keys an app's `export const runtime` may carry, held to `RuntimeOverrides` at load: a key it
// does not declare is a backend the app believes it swapped, and a spread or a non-literal object
// gets past `satisfies`. Refused by name (`X_CONFIG_INVALID`), never ignored.

import { ADAPTER_PORT_NAMES, ConfigInvalidError, renderCauseValue } from '@ultimat3/core';
import { isWired } from './runtime-ports';

/** The fields beside the ports: app extensions, not backends. */
const EXTENSIONS: ReadonlySet<string> = new Set(['middleware', 'routes']);

/** Deleted fields, each with the one line that replaces it. */
const REMOVED: Readonly<Record<string, string>> = Object.freeze({
  syncAuthenticate:
    'configureAuthenticator(resolve, { credentialTtlMs })   // the sync socket uses the app authenticator; delete runtime.syncAuthenticate',
});

const isPendingPort = (key: string): boolean =>
  (ADAPTER_PORT_NAMES as readonly string[]).includes(key) && !isWired(key);

/** Throws on the first key `RuntimeOverrides` does not declare. `file` is root-relative. */
export function assertRuntimeKeys(file: string, runtime: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(runtime)) {
    if (isWired(key) || EXTENSIONS.has(key)) continue;
    const named = renderCauseValue(key);
    const replacement = Object.hasOwn(REMOVED, key) ? REMOVED[key] : undefined;
    throw new ConfigInvalidError({
      cause: isPendingPort(key)
        ? `${file} sets runtime.${named}, which is not a runtime.ts field yet — the boot cannot install that port`
        : replacement !== undefined
          ? `${file} sets runtime.${named}, removed in 31.0.0`
          : `${file} sets runtime.${named}, which RuntimeOverrides does not declare, so no boot would read it`,
      fix:
        replacement ??
        'export const runtime = { /* only RuntimeOverrides fields */ } satisfies RuntimeOverrides;   // the type names every field',
    });
  }
}
