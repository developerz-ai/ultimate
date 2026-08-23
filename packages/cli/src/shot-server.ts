// The server a shot is taken against, and the hosts the page may reach while it is: the two
// facts a ROUTE capture and a COMPONENT capture share, and the only ones. Its own file so
// `island-shot.ts` can have them without importing the command that photographs a route, which
// would be a cycle between two files that otherwise have nothing to say to each other.

// why: no Bun native joins a path; `.x/shot` is a path both capture paths write under.
import { join } from 'node:path';
import { startDev } from './cmd-dev';
import { clearLock, isProcessAlive, lockPath, parseLock, preflight, writeLock } from './dev-lock';
import { DEV_BINDING } from './dev-roles';
import { resolveServices } from './dev-services';

export const SHOT_DIR = join('.x', 'shot');

/**
 * How `devServerFor` starts a scratch server. A parameter with a default rather than a direct
 * call, for the reason every `Runner` in this package is one: the failure path below — a boot that
 * throws, and the lock it has to hand back — is otherwise only reachable by breaking a real app.
 */
export type BootDevServer = (input: {
  readonly root: string;
  readonly port: number;
  readonly env: Readonly<Record<string, string | undefined>>;
}) => Promise<{ readonly url: string; stop(): Promise<void> }>;

export interface ShotServer {
  readonly url: string;
  /** Which server the picture is of. Reported, because the two have different failure modes. */
  readonly origin: 'booted' | 'reused';
  stop(): Promise<void>;
}

/**
 * One rule, two branches: photograph the `x dev` this checkout already has, or boot a scratch one.
 * Reusing is not a convenience — embedded Postgres is a single-writer directory, so a second boot
 * on one checkout is `X_DEV_ALREADY_RUNNING` and the picture would never be taken at all.
 */
export async function devServerFor(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  port: number,
  boot: BootDevServer = (input) => startDev(input),
): Promise<ShotServer> {
  const services = resolveServices(root, env);
  const file = Bun.file(lockPath(services.stateDir));
  if (await file.exists()) {
    const lock = parseLock(await file.text());
    if (lock !== null && isProcessAlive(lock.pid)) {
      return { url: lock.url, origin: 'reused', stop: () => Promise.resolve() };
    }
  }
  const { release } = await preflight({
    stateDir: services.stateDir,
    port,
    hostname: DEV_BINDING.hostname,
    embeddedDb: services.db.mode === 'embedded',
  });
  // The directory is CLAIMED from here down — `preflight` returns holding it, never having merely
  // looked — so a boot that throws has to give it back. `cmd-dev.ts` states the same rule at the
  // same seam. Without it one failed `x shot` refused every later `x dev` and `x shot` on this
  // checkout, naming a pid that had already exited. The original error is re-thrown untouched: a
  // teardown must never replace the failure it is cleaning up after.
  const dev = await boot({ root, port, env }).catch((error: unknown) => {
    release();
    throw error;
  });
  await writeLock(services.stateDir, {
    pid: process.pid,
    port,
    url: dev.url,
    startedAt: new Date().toISOString(),
  });
  return {
    url: dev.url,
    origin: 'booted',
    async stop() {
      clearLock(services.stateDir);
      await dev.stop();
    },
  };
}

/** `--allow-hosts a.com,b.com` on top of the app's own host. Empty means the app's host alone. */
export const allowHostsFrom = (url: string, extra: string | undefined): readonly string[] => {
  const named = (extra ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  return [new URL(url).hostname, ...named];
};
