// Boot an app in-process for a test: its own cloned database, a frozen clock, a seeded RNG and a
// sealed network, torn down afterwards. In-process because a spawned server turns every assertion
// into a race and every failure into a log-scraping exercise.

import { afterAll, beforeAll, describe, test } from 'bun:test';
import { captureDeterminism, installDeterminism, restoreCapturedDeterminism } from './determinism';
import {
  allowHost,
  isNetworkSealed,
  resetNetwork,
  sealNetwork,
  unsealNetwork,
} from './sealed-network';
import type { TemplateDbConfig, WorkerDatabase } from './template-db';
import { acquireWorkerDatabase } from './template-db';
import type { TestType } from './test-types';
import { testName } from './test-types';

export interface BootedApp {
  /** The app's request handler — the same one `ROLE=web` serves in production. */
  fetch(request: Request): Response | Promise<Response>;
  close?(): Promise<void>;
}

export interface AppOptions {
  /** Boot the app against the database URL the harness just cloned. */
  boot(context: { readonly databaseUrl: string }): Promise<BootedApp>;
  readonly db?: TemplateDbConfig;
  readonly seed?: (databaseUrl: string) => Promise<void>;
  /** Hosts the test may reach for real. Everything else fails with X_TEST_NETWORK_SEALED. */
  readonly allowHosts?: readonly string[];
  readonly seedValue?: number;
  readonly now?: string;
}

export interface AppHandle {
  readonly db: WorkerDatabase;
  /** Call the app by path: `app.request('/api/health')`. */
  request(path: string, init?: RequestInit): Promise<Response>;
  json<T>(path: string, init?: RequestInit): Promise<T>;
}

const BASE = 'http://app.test';

export interface BootedHarness {
  readonly handle: AppHandle;
  close(): Promise<void>;
}

export interface HarnessDeps {
  /**
   * How this harness gets a database. A parameter for the reason `TemplateDbDeps.connect` is one:
   * the rejection path below drops what it acquired, and the PGlite fallback's `drop` is a no-op,
   * so proving it needs an injected handle rather than a server.
   */
  readonly acquire: (config: TemplateDbConfig) => Promise<WorkerDatabase>;
}

/**
 * The lifecycle `describeApp` and `testApp` are the two idiomatic wrappers around. Exported from
 * this module but deliberately NOT from `src/index.ts`: those two are the ways an app boots, and a
 * third public entry point would be a second answer to one question. It is exported at all because
 * the teardown contract — a rejecting `close` must still drop the cloned database — cannot be
 * asserted through a wrapper that rethrows into the test's own result.
 */
export async function bootApp(
  options: AppOptions,
  deps: Partial<HarnessDeps> = {},
): Promise<BootedHarness> {
  // Captured, never assumed. The preload already sealed the network and installed determinism for
  // the whole process, so `sealNetwork()` here is a no-op and an unconditional teardown would hand
  // the real `fetch`, the real `Date` and the real `Math.random` to every later FILE in the run —
  // `bun test` is one process. Restore only what this boot actually changed.
  const determinism = captureDeterminism();
  const sealedBefore = isNetworkSealed();

  // Only when this boot has something of its own to say. A run configured with ULTIMATE_TEST_NOW /
  // ULTIMATE_TEST_SEED (`preload.ts`) is otherwise reset to the defaults by the first describeApp.
  if (!determinism.installed || options.seedValue !== undefined || options.now !== undefined) {
    installDeterminism({
      ...(options.seedValue === undefined ? {} : { seed: options.seedValue }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }
  sealNetwork();
  for (const host of options.allowHosts ?? []) allowHost(host);

  // What `close` puts back, named once: the boot has to run it too, and two copies of this list is
  // how one of them ends up missing the allow-list.
  const restoreProcessState = (): void => {
    resetNetwork();
    if (!sealedBefore) unsealNetwork();
    restoreCapturedDeterminism(determinism);
  };

  let db: WorkerDatabase | undefined;
  let app: BootedApp;
  try {
    db = await (deps.acquire ?? acquireWorkerDatabase)(options.db ?? {});
    if (options.seed !== undefined) await options.seed(db.url);
    app = await options.boot({ databaseUrl: db.url });
  } catch (error) {
    // A boot that rejects returns no `BootedHarness`, so nothing can ever call the `close` below —
    // the same leak that block exists to prevent, one function earlier. A failing `seed` stranded
    // its clone and left the clock, the seal and the allow-list this boot installed to every later
    // FILE in the run; `bun test` is one process.
    try {
      await db?.drop();
    } catch {
      // The boot's own failure is what the caller must see, and there is no handle to report a
      // second one through — the same "first failure wins" rule `close` runs by.
    }
    restoreProcessState();
    throw error;
  }

  const handle: AppHandle = {
    db,
    request: async (path, init) => app.fetch(new Request(new URL(path, BASE), init)),
    json: async <T>(path: string, init?: RequestInit): Promise<T> => {
      const response = await app.fetch(new Request(new URL(path, BASE), init));
      return (await response.json()) as T;
    },
  };

  return {
    handle,
    // Every step runs even when an earlier one rejects, and the FIRST failure is what the caller
    // sees — the same rule `fixtures.ts` disposes by. An `app.close()` that threw used to strand
    // the clone: one `ultimate_test_template_wN` leaked per failing run, and the seal and the
    // clock were never put back either.
    close: async () => {
      let failure: { readonly error: unknown } | undefined;
      try {
        await app.close?.();
      } catch (error) {
        failure = { error };
      }
      try {
        await db.drop();
      } catch (error) {
        failure ??= { error };
      }
      restoreProcessState();
      if (failure !== undefined) throw failure.error;
    },
  };
}

/**
 * A describe block with the app booted once for every test inside it. The accessor is a function
 * because the app does not exist until beforeAll has run.
 */
export function describeApp(
  name: string,
  options: AppOptions,
  body: (app: () => AppHandle) => void,
): void {
  describe(name, () => {
    let booted: BootedHarness | undefined;
    beforeAll(async () => {
      booted = await bootApp(options);
    });
    afterAll(async () => {
      await booted?.close();
      booted = undefined;
    });
    body(() => {
      if (booted === undefined) throw new ReferenceError('app is not booted yet');
      return booted.handle;
    });
  });
}

/** A single test with its own app, for the cases that need an isolated boot. */
export function testApp(
  name: string,
  options: AppOptions,
  body: (app: AppHandle) => Promise<void>,
  type: TestType = 'unit',
): void {
  test(testName(type, name), async () => {
    const booted = await bootApp(options);
    try {
      await body(booted.handle);
    } finally {
      await booted.close();
    }
  });
}
