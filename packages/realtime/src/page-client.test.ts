// The acceptance test for "one store, one socket per PAGE": two islands are two separately built
// bundles, each with its own copy of this package and of `@ultimat3/core`. Both copies must reach
// ONE record store and open ONE socket — which a module-scope singleton could never do, because
// it is one per bundle. Built for real with `Bun.build`, the way `x build` builds an island.

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
  RecordStore: unknown;
}

let dir = '';
let first: IslandCopy;
let second: IslandCopy;
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

async function island(name: string): Promise<IslandCopy> {
  // An island's own entry, importing the barrel the way island code does.
  const entry = `${dir}/${name}.ts`;
  await Bun.write(
    entry,
    `export { installRealtime, RecordStore, useQuery, useRecord } from '${import.meta.dir}/index.ts';\n`,
  );
  // A separate `bun build`, as `x build` runs one: inside the test runtime, `Bun.build` resolves a
  // workspace package's own imports differently from the CLI, and the CLI is what ships.
  const out = `${dir}/${name}`;
  const built = Bun.spawnSync([
    process.execPath,
    'build',
    entry,
    '--target=browser',
    `--outdir=${out}`,
  ]);
  if (built.exitCode !== 0) expect(built.stderr.toString()).toBe('');
  const output = `${out}/${name}.js`;
  return (await import(output)) as IslandCopy;
}

beforeAll(async () => {
  resetPage();
  dir = await mkdtemp(`${tmpdir()}/ultimate-page-client-`);
  (globalThis as { WebSocket?: unknown }).WebSocket = CountingSocket;
  first = await island('first');
  second = await island('second');
});

afterAll(async () => {
  resetPage();
  globalThis.WebSocket = realWebSocket;
  await rm(dir, { recursive: true, force: true });
});

describe('two island bundles on one page', () => {
  test('are two copies of the package — the premise, or this test proves nothing', () => {
    expect(first.RecordStore).not.toBe(second.RecordStore);
  });

  test('share ONE record store: a record adopted through either shows in both', () => {
    const sync = { url: 'ws://node.test/_x/sync', buildId: 'build-1' };
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
