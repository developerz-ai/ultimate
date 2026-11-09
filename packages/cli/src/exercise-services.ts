// The runtime services a server's boot installs (`runtime-services.ts`) that `x exercise` stands in
// for: a storage disk, a fleet-wide rate-limit store and the Web Push runtime, over the pass's
// scratch database. Without them every primitive reading one stopped on a boot-only refusal and
// the app had to declare `{ off }` for it — the pass's job, not the app's.

import type { AppConfig, PgExecutor } from '@ultimat3/core';
import { ENVIRONMENT_KEY } from '@ultimat3/core';
import { postgresRateLimitStore } from '@ultimat3/http';
import { installRateLimitStore } from '@ultimat3/http/adapter';
import {
  definedStorage,
  defineStorage,
  memoryStorageDriver,
  resetStorage,
} from '@ultimat3/storage';
import type { Env } from './runtime-bindings';
import { selectWebPush } from './runtime-push';

export interface ExerciseServiceInputs {
  /** The app's one loaded config — `undefined` for an app with no `app.config.ts`. */
  readonly config: AppConfig | undefined;
  readonly env: Env;
  /** The scratch database the pass seeds: the boot's stores live there, as on a server. */
  readonly executor: PgExecutor;
}

/**
 * The disk an embedded boot names (`startStorage`'s `local`), held in memory: the pass's objects
 * die with it, exactly as its rows die with the scratch database. Only when the app installed none
 * — an app that defined its own storage keeps it, and gets it back untouched.
 */
function installStorage(): () => void {
  if (definedStorage() !== undefined) return () => undefined;
  const installed = defineStorage({ disks: { local: memoryStorageDriver() }, default: 'local' });
  return () => {
    if (definedStorage() === installed) resetStorage();
  };
}

/**
 * A push service that accepts every message, as the memory mail driver accepts every mail: the pass
 * seals the network, and a notifier fanning out to a seeded device must reach its handler's end,
 * not a 5xx from a send nobody could receive.
 */
const capturedPush: typeof fetch = Object.assign(
  async (): Promise<Response> => new Response(null, { status: 201 }),
  { preconnect: fetch.preconnect },
);

async function installPush(inputs: ExerciseServiceInputs): Promise<() => void> {
  // As `test`, whatever the caller's env names: the pass always runs as one (`exerciseEnvironment`),
  // so an app with no sealed pair signs with the development pair, as its `bun test` does.
  const env = { ...inputs.env, [ENVIRONMENT_KEY]: 'test' };
  const selection = await selectWebPush(inputs.config, env);
  if (selection === undefined) return () => undefined;
  const { installWebPush, postgresPushSubscriptionStore } = await import('@ultimat3/pwa');
  return installWebPush({
    store: postgresPushSubscriptionStore({ executor: inputs.executor }),
    keys: selection.resolved.keys,
    subject: selection.subject,
    pushHosts: selection.pushHosts,
    fetch: capturedPush,
  });
}

/** Installs every stand-in; answers the release, newest first. Installing sends no statement. */
export async function installExerciseServices(inputs: ExerciseServiceInputs): Promise<() => void> {
  const released: (() => void)[] = [];
  const undo = (): void => {
    for (const release of released.toReversed()) release();
  };
  try {
    released.push(installStorage());
    // `scope: 'shared'`, as the boot's: a `rateLimit: { scope: 'shared' }` declaration is judged
    // against the installed store, and one process' memory refused it with X_RATE_LIMIT_NOT_SHARED.
    released.push(installRateLimitStore(postgresRateLimitStore({ executor: inputs.executor })));
    // Last, and the one that can refuse (a half VAPID pair): what is already in is undone first.
    released.push(await installPush(inputs));
  } catch (error) {
    undo();
    throw error;
  }
  return undo;
}
