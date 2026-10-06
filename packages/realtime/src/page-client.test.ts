// The acceptance test for "one runtime, one store, one socket per PAGE": two islands are two
// separately built bundles, each with its own copy of the hooks and of `@ultimat3/core`, and the
// page runtime is a THIRD build, loaded once. Both islands must reach its one store and open ONE
// socket while carrying none of it (#505). Built for real, the way `x build` builds an island.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: `node:fs`/`node:os` — Bun has no temp-directory API and no recursive remove.
import { mkdtemp, rm } from 'node:fs/promises';
// why: `node:os` — the temp directory's location; Bun exposes none.
import { tmpdir } from 'node:os';
import type { AsyncState, Row } from '@ultimat3/core';
import { resetPage, signal } from './hooks-fixture';

interface IslandCopy {
  installRealtime(install: unknown): void;
  useRecord(type: string, key: string): () => AsyncState<Row | undefined>;
  useQuery(ref: unknown, input: unknown): () => AsyncState<readonly Row[]>;
}

interface RuntimeCopy {
  installPageRuntime(): { readonly store: unknown };
}

/** A string only `record-store.ts` holds: present in a bundle exactly when the store's code is. */
const STORE_CODE = 'it arrived under an empty key';

let dir = '';
let first: IslandCopy;
let second: IslandCopy;
let runtime: RuntimeCopy;
/** Every bundle's emitted code, by name — what a browser would download for each. */
const code = new Map<string, string>();
const dialled: string[] = [];
/** Bun's own, put back afterwards: a suite later in this process dials a real node with it. */
const realWebSocket = globalThis.WebSocket;

/** A browser `WebSocket` that never connects, and counts how many times it was constructed. */
class CountingSocket {
  static readonly OPEN = 1;
  readonly bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(url: string) {
    dialled.push(url);
  }
  send(): void {}
  close(): void {}
}

// Awaited, never `Bun.spawnSync`: a synchronous wait holds the test worker's only thread, so a
// child that does not come back is a worker the test timeout cannot end.
const spawned = async (
  cmd: readonly string[],
  env?: Record<string, string | undefined>,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const child = Bun.spawn([...cmd], {
    stdout: 'pipe',
    stderr: 'pipe',
    ...(env === undefined ? {} : { env }),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
};

/** An island's own entry, importing the barrel the way island code does. */
const ISLAND_SOURCE = `export { installRealtime, useQuery, useRecord } from '${import.meta.dir}/index.ts';\n`;

/** The page runtime's entry, as the CLI's runtime chunk is built from it. */
const RUNTIME_SOURCE = `export { installPageRuntime } from '${import.meta.dir}/page-runtime.ts';\n`;

async function bundle<T>(name: string, source: string): Promise<T> {
  const entry = `${dir}/${name}.ts`;
  await Bun.write(entry, source);
  // A separate `bun build`, as `x build` runs one: inside the test runtime, `Bun.build` resolves a
  // workspace package's own imports differently from the CLI, and the CLI is what ships.
  const out = `${dir}/${name}`;
  const built = await spawned([
    process.execPath,
    'build',
    entry,
    '--target=browser',
    `--outdir=${out}`,
  ]);
  if (built.exitCode !== 0) expect(built.stderr).toBe('');
  const output = `${out}/${name}.js`;
  code.set(name, await Bun.file(output).text());
  return (await import(output)) as T;
}

beforeAll(async () => {
  resetPage();
  dir = await mkdtemp(`${tmpdir()}/ultimate-page-client-`);
  (globalThis as { WebSocket?: unknown }).WebSocket = CountingSocket;
  first = await bundle<IslandCopy>('first', ISLAND_SOURCE);
  second = await bundle<IslandCopy>('second', ISLAND_SOURCE);
  runtime = await bundle<RuntimeCopy>('runtime', RUNTIME_SOURCE);
});

afterAll(async () => {
  resetPage();
  globalThis.WebSocket = realWebSocket;
  await rm(dir, { recursive: true, force: true });
});

describe('two island bundles on one page', () => {
  test('are two copies of the package — the premise, or this test proves nothing', () => {
    expect(first.useRecord).not.toBe(second.useRecord);
  });

  test('carry none of the store: its code is in the page runtime, once', () => {
    expect(code.get('first')).not.toContain(STORE_CODE);
    expect(code.get('second')).not.toContain(STORE_CODE);
    expect(code.get('runtime')).toContain(STORE_CODE);
  });

  test('share ONE record store: a record adopted through either shows in both', () => {
    const sync = { url: 'ws://node.test/_x/sync', buildId: 'build-1' };
    // What the page boot (or the runtime chunk) does before any island's hook runs.
    const installed = runtime.installPageRuntime();
    expect(runtime.installPageRuntime()).toBe(installed); // once per page, whoever asks again
    first.installRealtime({ signal, sync });
    second.installRealtime({ signal, sync });
    const a = first.useRecord('posts', 'p1');
    const b = second.useRecord('posts', 'p1');

    const sink = (globalThis as Record<symbol, { store?: { adopt(t: string, r: object): void } }>)[
      Symbol.for('ultimate.client')
    ]?.store;
    sink?.adopt('posts', { p1: { id: 'p1', title: 'hello' } });

    const left = a();
    const right = b();
    expect(left).toEqual({ status: 'ready', data: { id: 'p1', title: 'hello' } });
    // The same OBJECT, not two equal copies: one record, shown in two places.
    expect(left.status === 'ready' && right.status === 'ready' && left.data === right.data).toBe(
      true,
    );
  });

  test('open ONE socket between them, however many live reads each holds', async () => {
    first.useQuery({ name: 'feed', live: true }, null);
    second.useQuery({ name: 'feed', live: true }, null);
    second.useQuery({ name: 'other', live: true }, null);
    // The in-page host's engine hears the tab over a MessageChannel, which delivers a task later.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(dialled).toEqual(['ws://node.test/_x/sync?build=build-1']);
  });
});
