// Boot an app in-process for a test: its own cloned database, a frozen clock, a seeded RNG and a
// sealed network, torn down afterwards. In-process because a spawned server turns every assertion
// into a race and every failure into a log-scraping exercise.

import { afterAll, beforeAll, describe, test } from 'bun:test';
import { installDeterminism, restoreDeterminism } from './determinism';
import { allowHost, resetNetwork, sealNetwork, unsealNetwork } from './sealed-network';
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

async function boot(
  options: AppOptions,
): Promise<{ handle: AppHandle; close: () => Promise<void> }> {
  installDeterminism({
    ...(options.seedValue === undefined ? {} : { seed: options.seedValue }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  sealNetwork();
  for (const host of options.allowHosts ?? []) allowHost(host);

  const db = await acquireWorkerDatabase(options.db ?? {});
  if (options.seed !== undefined) await options.seed(db.url);
  const app = await options.boot({ databaseUrl: db.url });

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
    close: async () => {
      await app.close?.();
      await db.drop();
      resetNetwork();
      unsealNetwork();
      restoreDeterminism();
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
    let booted: { handle: AppHandle; close: () => Promise<void> } | undefined;
    beforeAll(async () => {
      booted = await boot(options);
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
    const booted = await boot(options);
    try {
      await body(booted.handle);
    } finally {
      await booted.close();
    }
  });
}
