// The app an e2e suite drives, spawned on a THROWAWAY state directory: its own embedded database,
// its own disk, its own dev lock, created per call and removed on `stop()`. Never the developer's
// `.x/pgdata` — resetting that from a test run destroys the data an `x dev` beside it is using.

// why: Bun ships no temp-directory primitive or recursive remove; `tmpdir()` is node:os's alone.
import { mkdtemp, rm } from 'node:fs/promises';
// why: the readiness poll must not go through `globalThis.fetch` — inside `bun test` the testing
// preload SEALS it, and the app's `/readyz` would be refused as egress. `node:http` is not sealed.
import { get } from 'node:http';
// why: Bun exposes no tmpdir() — only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path API — the state dir and the CLI's own bin are joined, not concatenated.
import { join } from 'node:path';
import { finiteCount } from '@ultimat3/core';
import { E2eAppFailedError } from './e2e-errors';

/** `x dev` (sync included), or the production entry `apps/web/server.ts` under `ROLE=web`. */
export type E2eAppMode = 'dev' | 'serve';

export interface StartE2eAppOptions {
  /** The app root — the directory holding `app.config.ts`. */
  readonly root: string;
  readonly mode?: E2eAppMode | undefined;
  /**
   * The arguments after `x db seed`, or `false` for no seeding. Default `['--tier', 'dev']`: every
   * dev-tier seed, which is what a developer's own `x dev` starts from.
   */
  readonly seed?: readonly string[] | false | undefined;
  /** Extra environment for every process — the reset, the seed and the app. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** How long the app may take to answer `/readyz`. */
  readonly readyTimeoutMs?: number | undefined;
}

export interface E2eApp {
  /** `http://localhost:<port>`, no trailing slash. */
  readonly base: string;
  /** The throwaway `.x` this app runs on — the one directory a test may inspect or corrupt. */
  readonly stateDir: string;
  /** Kill the app and delete its state directory. Idempotent. */
  stop(): Promise<void>;
  /**
   * Stop the app and start it again on the SAME port and state directory, with `env` added — a
   * deploy. `{ BUILD_ID: 'b2' }` is a new build the open tabs have not seen (`deploy.newBuild()`).
   */
  restart(env?: Readonly<Record<string, string>>): Promise<void>;
}

/** The CLI this process IS — never a global `x`, which may be a different version of the framework. */
const X_BIN = join(import.meta.dir, 'bin.ts');
const DEFAULT_READY_TIMEOUT_MS = 90_000;
const POLL_MS = 250;

/** A port nothing holds right now, asked of the OS and handed to the child. */
const freePort = (): number => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port ?? 0;
  probe.stop(true);
  return port;
};

/**
 * This process's environment minus what makes the child a TEST process. Spawned from `bun test`,
 * `NODE_ENV=test` rode along and the app resolved its environment as `test` — so a development-only
 * seam (the demo viewer an app installs instead of a sign-in route) was off and every page 401'd.
 * The app under e2e is a development app unless the caller's `env` says otherwise.
 */
const inherited = (): Record<string, string | undefined> => {
  const { NODE_ENV: _node, ...rest } = Bun.env;
  return { ...rest, ULTIMATE_ENV: 'development' };
};

const refuse = (step: string, output: string): E2eAppFailedError =>
  new E2eAppFailedError({ step, output });

function x(args: readonly string[], root: string, env: Record<string, string>): void {
  const run = Bun.spawnSync(['bun', X_BIN, ...args], {
    cwd: root,
    env: { ...inherited(), ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (run.exitCode !== 0) {
    throw refuse(`x ${args.join(' ')}`, `${run.stdout.toString()}${run.stderr.toString()}`);
  }
}

/**
 * Reset and seed a fresh state directory, then spawn the app on a free port and wait for `/readyz`.
 * The reset runs against the throwaway directory, so it is a first migration, never a data loss.
 */
export async function startE2eApp(options: StartE2eAppOptions): Promise<E2eApp> {
  // Screened FIRST, before a directory or a process exists: `waited < NaN` is false, so a NaN budget would never poll and report a dead app.
  const deadline = finiteCount(
    'startE2eApp',
    'readyTimeoutMs',
    options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
  );
  const stateDir = await mkdtemp(join(tmpdir(), 'ultimate-e2e-'));
  const env: Record<string, string> = { ...options.env, ULTIMATE_STATE_DIR: stateDir };
  const cleanup = (): Promise<void> => rm(stateDir, { recursive: true, force: true });
  try {
    x(['db', 'reset'], options.root, env);
    const seed = options.seed ?? ['--tier', 'dev'];
    if (seed !== false) x(['db', 'seed', ...seed], options.root, env);
  } catch (error) {
    await cleanup();
    throw error;
  }
  const port = freePort();
  // Its own scrape port too: every role opens one, the default is a fixed 9090, and a second app —
  // or a developer's `x dev` — already holding it is an app that dies at boot with X_PORT_IN_USE.
  const metricsPort = freePort();
  const base = `http://localhost:${String(port)}`;
  const command =
    options.mode === 'serve'
      ? ['bun', 'apps/web/server.ts']
      : ['bun', X_BIN, 'dev', '--port', String(port)];
  const spawnApp = (extra: Readonly<Record<string, string>>) =>
    Bun.spawn(command, {
      cwd: options.root,
      env: {
        ...inherited(),
        ...env,
        METRICS_PORT: String(metricsPort),
        // The origin the app is actually reachable at. A page that renders a typed client builds
        // its absolute URLs from it, and without it `/feed` answered 500 with X_ENV_MISSING APP_URL.
        APP_URL: base,
        ...(options.mode === 'serve' ? { ROLE: 'web', PORT: String(port) } : {}),
        ...extra,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  const ready = async (child: ReturnType<typeof spawnApp>, tail: () => string): Promise<void> => {
    for (let waited = 0; waited < deadline; waited += POLL_MS) {
      if (child.exitCode !== null) break;
      if (await answersOk(`${base}/readyz`)) return;
      await Bun.sleep(POLL_MS);
    }
    child.kill();
    await child.exited;
    throw refuse(`${command.join(' ')} never answered ${base}/readyz`, tail());
  };

  let child = spawnApp({});
  // Drained from the start and kept bounded: an app's log is unbounded, and a pipe nobody reads
  // fills its buffer and blocks the child on its next write — an app that "never got ready".
  let tail = drainTail(child.stdout, child.stderr);
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    child.kill();
    await child.exited;
    await cleanup();
  };
  try {
    await ready(child, tail);
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    base,
    stateDir,
    stop,
    async restart(next: Readonly<Record<string, string>> = {}): Promise<void> {
      // The same port and the same state directory — a deploy, not a second app: a tab already
      // open on `base` sees the new build on its next request, and the data it wrote is still there.
      child.kill();
      await child.exited;
      child = spawnApp(next);
      tail = drainTail(child.stdout, child.stderr);
      await ready(child, tail);
    },
  };
}

const TAIL_CHARS = 16_000;

/** Read both streams to their end in the background; answer the last `TAIL_CHARS` of either. */
function drainTail(...streams: readonly ReadableStream<Uint8Array>[]): () => string {
  let text = '';
  for (const stream of streams) {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        text = (text + decoder.decode(chunk, { stream: true })).slice(-TAIL_CHARS);
      }
    })().catch(() => undefined);
  }
  return () => text;
}

/** One GET, answered as "2xx or not" — never a throw, and never through the sealed `fetch`. */
function answersOk(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get(url, (response) => {
      response.resume();
      const status = response.statusCode ?? 0;
      resolve(status >= 200 && status < 300);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(POLL_MS * 4, () => {
      request.destroy();
      resolve(false);
    });
  });
}
