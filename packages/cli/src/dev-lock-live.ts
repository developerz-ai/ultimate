// Whether a LIVE `x dev` holds a state directory, asked by the commands that must not open or
// delete its embedded database beside it. A pid alone is not the holder: a kill -9 leaves the lock
// and the kernel reuses the number, and a stranger on that pid refused every `x db` command.

import { DevAlreadyRunningError, type DevLock, liveDevLock } from './dev-lock';
import { reusedPid } from './dev-lock-identity';
import { resolveServices } from './runtime-bindings';

/** The lock of the `x dev` that wrote it and is still running; a reused pid is no holder. */
export async function liveDevLockChecked(stateDir: string): Promise<DevLock | undefined> {
  const lock = liveDevLock(stateDir);
  return lock === undefined || (await reusedPid(lock)) ? undefined : lock;
}

/**
 * `X_DEV_ALREADY_RUNNING` when an `x dev` holds the embedded database under `stateDir`. PGlite
 * takes no lock of its own: a second process opens the directory, writes, and the holder's next
 * write replaces the catalog it wrote — measured, a `create table` from the second opener is gone.
 */
export async function refuseBesideDev(stateDir: string, resume?: readonly string[]): Promise<void> {
  const holder = await liveDevLockChecked(stateDir);
  if (holder !== undefined) {
    throw new DevAlreadyRunningError({
      lock: holder,
      stateDir,
      embeddedDb: true,
      ...(resume === undefined ? {} : { resume }),
    });
  }
}

/**
 * The same refusal for a command that WRITES through its own boot (`x db seed`, `x jobs retry`):
 * only when this checkout's database is the embedded one — an external Postgres takes any number
 * of writers. `resume` is the command as typed, which the fix runs between `x stop` and `x dev`.
 */
export async function refuseEmbeddedWriteBesideDev(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  resume: readonly string[],
): Promise<void> {
  const services = resolveServices(root, env);
  if (services.db.mode === 'embedded') await refuseBesideDev(services.stateDir, resume);
}
