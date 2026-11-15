// The boot's half of core's `bootWarning`: the roles this process runs and the per-build memory —
// a zero-byte marker on the disk every pod of a deploy shares (`retained-assets-warned.ts`) —
// installed once by `startRoles`. The marker and storage modules load on the first `once: 'build'`
// claim, so a role that never says one evaluates neither.

import type { AppConfig, BuildOnceStore, Role } from '@ultimat3/core';
import { resolveEnvironment } from '@ultimat3/core';
import { installBootWarnings } from '@ultimat3/core/adapter';
import type { Storage } from '@ultimat3/storage';
import { retainedPrefix } from './retained-assets-layout';

/** The code whose marker predates the store: it keeps `<prefix>/warned/<role>/`. */
const RETAIN_UNDECLARED = 'X_ASSET_RETAIN_UNDECLARED';

/**
 * Core's `once: 'build'` memory over `warnOncePerBuild`. The retain warning keeps the marker it
 * always had, `<prefix>/warned/<role>/`; any other code is `<role>~<code>`, its own directory, so
 * neither silences nor prunes the other. The app's own disks win over the host's, as every
 * framework route reads them (`servedStorage`).
 */
export function retainedBuildOnce(input: {
  readonly storage: Storage;
  readonly prefix: string;
  readonly buildId: string;
}): BuildOnceStore {
  return async (claim, say) => {
    const [{ warnOncePerBuild }, { servedStorage }] = await Promise.all([
      import('./retained-assets-warned'),
      import('./runtime-storage'),
    ]);
    const storage = servedStorage(input.storage);
    await warnOncePerBuild(
      {
        disk: () => storage.disk(),
        prefix: input.prefix,
        role: claim.code === RETAIN_UNDECLARED ? claim.role : `${claim.role}~${claim.code}`,
        buildId: input.buildId,
      },
      say,
    );
  };
}

export interface RoleBootWarningsInput {
  readonly roles: readonly Role[];
  /** `undefined` with no `app.config.ts`: no app name to scope a marker by, so no build store. */
  readonly config: Pick<AppConfig, 'name'> | undefined;
  readonly storage: Storage;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly buildId: string;
}

/** Installs the booting roles and, with an app config, the build store. Returns the release. */
export function installRoleBootWarnings(input: RoleBootWarningsInput): () => void {
  if (input.config === undefined) return installBootWarnings({ roles: input.roles });
  const environment = resolveEnvironment({ env: input.env, fallback: 'production' });
  return installBootWarnings({
    roles: input.roles,
    buildOnce: retainedBuildOnce({
      storage: input.storage,
      prefix: retainedPrefix(input.config.name, environment),
      buildId: input.buildId,
    }),
  });
}
