// The e2e app's PROCESS half: spawn it on a free port, wait for `/readyz`, restart it on the same
// port as a deploy, stop it. Split from `e2e-app.ts`, which owns the DATABASE half (the throwaway
// state directory, the reset and the seed), so this half runs against any root with an entry —
// which is what lets a unit test drive it without a Postgres.

// why: the readiness poll must not go through `globalThis.fetch` — inside `bun test` the testing
// preload SEALS it, and the app's `/readyz` would be refused as egress. `node:http` is not sealed.
import { get } from 'node:http';
// why: Bun exposes no path API — the CLI's bin is joined onto its package directory.
import { dirname, join } from 'node:path';
import { assert } from '@ultimat3/core';
import { E2eAppFailedError } from './e2e-errors';

/** `x dev` (sync included), or the production entry `apps/web/server.ts` under `ROLE=web`. */
export type E2eAppMode = 'dev' | 'serve';

/**
 * The `x` the APP installed, read off `@ultimat3/cli`'s own `bin` entry and resolved from the app
 * root — never a global `x`, which may be a different version of the framework, and never beside
 * this module: `@ultimat3/testing` does not depend on the CLI, and the `import.meta.dir/bin.ts`
 * this was while the driver lived in cli named a file that does not exist once it moved here.
 */
export async function xBin(root: string): Promise<string> {
  let manifest: string;
  try {
    manifest = Bun.resolveSync('@ultimat3/cli/package.json', root);
  } catch {
    throw new E2eAppFailedError({
      step: 'resolve @ultimat3/cli',
      output: `@ultimat3/cli does not resolve from ${root}`,
      fix: 'bun add -d @ultimat3/cli   # in the app root: the e2e app is spawned through the CLI the app itself installed',
    });
  }
  const declared: unknown = await Bun.file(manifest).json();
  const bin =
    typeof declared === 'object' && declared !== null ? Reflect.get(declared, 'bin') : undefined;
  const x = typeof bin === 'object' && bin !== null ? Reflect.get(bin, 'x') : undefined;
  if (typeof x !== 'string') {
    throw refuse('resolve @ultimat3/cli', `${manifest} declares no "bin": { "x": … } entry`);
  }
  return join(dirname(manifest), x);
}
const POLL_MS = 250;

export interface SpawnedE2eApp {
  /** `http://localhost:<port>`, no trailing slash. */
  readonly base: string;
  /** Kill the process. Idempotent. */
  stop(): Promise<void>;
  /** Kill it and start it again on the SAME port, with `env` added — a deploy. Refused after `stop()`. */
  restart(env?: Readonly<Record<string, string>>): Promise<void>;
}

export interface SpawnE2eAppOptions {
  readonly root: string;
  readonly mode: E2eAppMode;
  /** Every spawn's environment, on top of this process's minus `NODE_ENV`. */
  readonly env: Readonly<Record<string, string>>;
  /** Already screened finite by the caller. */
  readonly readyTimeoutMs: number;
  /** `xBin(root)`, when the caller already resolved it; resolved here otherwise, in `dev` mode only. */
  readonly bin?: string | undefined;
}

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
export const inherited = (): Record<string, string | undefined> => {
  const { NODE_ENV: _node, ...rest } = Bun.env;
  return { ...rest, ULTIMATE_ENV: 'development' };
};

export const refuse = (step: string, output: string): E2eAppFailedError =>
  new E2eAppFailedError({ step, output });

/** Spawn the app and answer once `/readyz` does; refuses with the app's own output tail. */
export async function spawnE2eApp(options: SpawnE2eAppOptions): Promise<SpawnedE2eApp> {
  const deadline = options.readyTimeoutMs;
  const port = freePort();
  // Its own scrape port too: every role opens one, the default is a fixed 9090, and a second app —
  // or a developer's `x dev` — already holding it is an app that dies at boot with X_PORT_IN_USE.
  const metricsPort = freePort();
  const base = `http://localhost:${String(port)}`;
  const command =
    options.mode === 'serve'
      ? ['bun', 'apps/web/server.ts']
      : ['bun', options.bin ?? (await xBin(options.root)), 'dev', '--port', String(port)];
  const spawnApp = (extra: Readonly<Record<string, string>>) =>
    Bun.spawn(command, {
      cwd: options.root,
      env: {
        ...inherited(),
        ...options.env,
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
  };
  try {
    await ready(child, tail);
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    base,
    stop,
    async restart(next: Readonly<Record<string, string>> = {}): Promise<void> {
      // `stop()` is final. A child respawned here would be one no later `stop()` kills — the flag
      // already says done — and `startE2eApp` has deleted the state directory it would boot on.
      assert(
        !stopped,
        'restart() was called on an e2e app that was already stopped, so there is no app to deploy over',
        'startE2eApp({ root }) again for a fresh app — restart() is for an app that is still running',
      );
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
