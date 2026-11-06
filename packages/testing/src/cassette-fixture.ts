// What the cassette suites share: a throwaway directory, an env var set for one block, and the
// "vendor" a recording runs against — `mockFetch` answers, which the tap records as it would a
// real host's. Not shipped (`!src/**/*-fixture.ts`).

// why: a throwaway directory per test; Bun has no mkdtemp or recursive rm of its own.
import { mkdtempSync, rmSync } from 'node:fs';
// why: the OS temp directory, for the same reason.
import { tmpdir } from 'node:os';
// why: joined from the temp root; Bun has no path join.
import { join } from 'node:path';
import { CASSETTE_ENV } from './cassette';
import { captureNetwork, mockFetch, restoreCapturedNetwork } from './sealed-network';

export const VENDOR_HOST = 'api.vendor.test';
export const VENDOR = `https://${VENDOR_HOST}`;

export interface TempDir extends Disposable {
  readonly path: string;
}

export function tempDir(): TempDir {
  const path = mkdtempSync(join(tmpdir(), 'x-cassette-'));
  return { path, [Symbol.dispose]: () => rmSync(path, { recursive: true, force: true }) };
}

/** Env vars set for the duration of `body`, then put back exactly — absent stays absent. */
export async function withEnv<T>(
  vars: Readonly<Record<string, string | undefined>>,
  body: () => Promise<T>,
): Promise<T> {
  const before = new Map(Object.keys(vars).map((key) => [key, Bun.env[key]]));
  const put = (key: string, value: string | undefined) => {
    if (value === undefined) delete Bun.env[key];
    else Bun.env[key] = value;
  };
  for (const [key, value] of Object.entries(vars)) put(key, value);
  try {
    return await body();
  } finally {
    for (const [key, value] of before) put(key, value);
  }
}

/** Recording mode, CI unset: the switch a developer flips by hand. */
export const recordEnv = { [CASSETTE_ENV]: 'record', CI: undefined } as const;
export const replayEnv = { [CASSETTE_ENV]: undefined, CI: undefined } as const;

/**
 * Runs `body` with `vendor` answering `match` (handler or list, as `mockFetch` takes them), then
 * takes the vendor away: whatever a later replay answers came from the file, not this mock.
 */
export async function withVendor<T>(
  routes: ReadonlyArray<readonly [string, readonly (Response | Error)[]]>,
  body: () => Promise<T>,
): Promise<T> {
  const before = captureNetwork();
  for (const [match, answers] of routes) mockFetch(match, answers);
  try {
    return await body();
  } finally {
    restoreCapturedNetwork({ ...captureNetwork(), mocks: before.mocks });
  }
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
