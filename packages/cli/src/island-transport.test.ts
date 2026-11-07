// A realtime island sends through the page runtime's transport, never a copy of its own: it awaits
// the runtime before its module body runs, so core's `clientTransport` is already on the page, in
// the runtime chunk or the page boot. Real builds of a fixture app, evaluated in this process.
//
// Measured on `examples/dummy`, As of 2026-11-07: the run console (realtime + `rpc`) 130,515 →
// 128,878 B. Only the transport function goes: `rpc`'s `.stream()` keeps core's dispatch and
// decoders, which the runtime does not expose. A plain island loads no runtime, so it keeps its own.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete; `rm(…, { force: true })` removes a root that may not exist.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins a path.
import { join } from 'node:path';
import type { IslandBundle } from './island-bundle';
import { buildIslands } from './island-bundle';
import { isRuntimeChunk } from './island-runtime';
import { processRoot } from './process-root-fixture';

const ROOT = processRoot(join(import.meta.dir, '..', '.island-fixture', 'transport'));

/** A string only core's `client-transport.ts` holds: in a file exactly when the transport is. */
const TRANSPORT_CODE = 'answered 2xx with a body that is not JSON';

/** Reaches realtime, and sends one GET through core's transport at mount. */
const LIVE_SENDER = `import { clientTransport } from '@ultimat3/core/page';
import { useRecord } from '@ultimat3/realtime';
export function mount(): Promise<unknown> {
  useRecord('posts', 'p1');
  return clientTransport({ method: 'GET', url: '/api/ping' });
}
`;

/** The same send, from an island that reaches no realtime and so loads no runtime. */
const PLAIN_SENDER = `import { clientTransport } from '@ultimat3/core/page';
export function mount(): Promise<unknown> {
  return clientTransport({ method: 'GET', url: '/api/ping' });
}
`;

const write = (path: string, source: string): Promise<number> =>
  Bun.write(join(ROOT, path), source);

/** Every file of the bundle, written where a browser would find it: flat, under one directory. */
async function serve(bundle: IslandBundle, out: string): Promise<void> {
  for (const asset of [...bundle.chunks, ...bundle.shared]) {
    await Bun.write(join(out, asset.url.slice(1)), asset.code);
  }
}

/** Mount the island at `file` from the served bundle, with a fetch that records every URL. */
async function sendFrom(bundle: IslandBundle, file: string): Promise<readonly [unknown, string[]]> {
  const out = join(ROOT, 'out');
  await serve(bundle, out);
  const asked: string[] = [];
  const fetch = async (input: unknown): Promise<Response> => {
    asked.push(String(input));
    return Response.json({ pong: true });
  };
  Object.assign(globalThis, { document: {}, window: {}, fetch });
  const chunk = bundle.chunks.find((one) => one.file === file);
  const island = (await import(join(out, chunk?.url.slice(1) ?? ''))) as {
    mount: () => Promise<unknown>;
  };
  return [await island.mount(), asked];
}

const realFetch = globalThis.fetch;

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await write('package.json', JSON.stringify({ name: 'island-transport-fixture' }));
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  globalThis.fetch = realFetch;
  Reflect.deleteProperty(globalThis, 'document');
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.realtime'));
});

describe('a realtime island that sends', () => {
  test('carries no transport of its own, and its send goes through the runtime one', async () => {
    await write('apps/web/app/live.island.tsx', LIVE_SENDER);
    const bundle = await buildIslands(ROOT);
    const [chunk] = bundle.chunks;

    expect(chunk?.code).not.toContain(TRANSPORT_CODE);
    const runtime = bundle.shared.find((one) => isRuntimeChunk(one.url));
    expect(runtime?.code).toContain(TRANSPORT_CODE);
    expect(chunk?.imports).toEqual([runtime?.url ?? '']);

    const [answer, asked] = await sendFrom(bundle, 'apps/web/app/live.island.tsx');
    expect(answer).toEqual({ pong: true });
    expect(asked).toEqual(['/api/ping']);
  });
});

describe('an island with no runtime under it', () => {
  test('a plain island keeps its own transport, and sends with no runtime on the page', async () => {
    await write('apps/web/app/plain.island.tsx', PLAIN_SENDER);
    const bundle = await buildIslands(ROOT);
    const [chunk] = bundle.chunks;

    expect(chunk?.code).toContain(TRANSPORT_CODE);
    expect(chunk?.imports).toEqual([]);
    const [answer, asked] = await sendFrom(bundle, 'apps/web/app/plain.island.tsx');
    expect(answer).toEqual({ pong: true });
    expect(asked).toEqual(['/api/ping']);
  });

  // One split build shares a module between its entries, so a transport only a runtime can answer
  // would reach the plain island too — which never waits for one.
  test('a split build over both keeps the real transport, so the plain one still sends', async () => {
    await write('apps/web/app/live.island.tsx', LIVE_SENDER);
    await write('apps/web/app/plain.island.tsx', PLAIN_SENDER);
    const bundle = await buildIslands(ROOT, { sharedChunks: true });

    const [answer, asked] = await sendFrom(bundle, 'apps/web/app/plain.island.tsx');
    expect(answer).toEqual({ pong: true });
    expect(asked).toEqual(['/api/ping']);
    expect(Reflect.get(globalThis, Symbol.for('ultimate.realtime'))).toBeUndefined();
  });
});
