// Single responsibility: a caller-keyed data-directory snapshot, on the real embedded Postgres — a
// miss boots empty and is written, a hit restores the caller's state, a new key misses, and a hit
// is never written again.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API and no recursive remove.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { pgliteClient } from './pglite';
import { forgetSnapshot, snapshotKey } from './pglite-snapshot';
import { raw } from './sql';

const dir = mkdtempSync(join(tmpdir(), 'x-pglite-data-snapshot-'));
const VERSION = '0.0.0-data-snapshot-test';
const clientFor = (key: string, keep?: number) =>
  pgliteClient({
    version: async () => VERSION,
    dataSnapshot: { dir, key, ...(keep === undefined ? {} : { keep }) },
  });

afterAll(() => {
  for (const key of ['m1', 'm2', 'm3', 'm4']) forgetSnapshot(`${snapshotKey(VERSION)}-${key}`);
  rmSync(dir, { recursive: true, force: true });
});

const tableExists = async (client: ReturnType<typeof clientFor>): Promise<boolean> =>
  (
    await client.one<{ name: string | null }>(
      raw("select to_regclass('public.notes')::text as name"),
    )
  )?.name === 'notes';

describe('unit · pglite data snapshot', () => {
  test('a miss boots empty and writes; the same key restores the state; a hit is not rewritten', async () => {
    const first = clientFor('m1');
    try {
      expect(await first.restoredDataSnapshot()).toBe(false);
      await first.execute(raw('create table notes (id int primary key)'));
      expect(await first.saveDataSnapshot()).toBe(true);
    } finally {
      await first.close();
    }
    // A fresh process would read the file; this one's memo holds the same bytes, verified once.
    const second = clientFor('m1');
    try {
      expect(await second.restoredDataSnapshot()).toBe(true);
      expect(await tableExists(second)).toBe(true);
      expect(await second.saveDataSnapshot()).toBe(false);
    } finally {
      await second.close();
    }
  }, 60_000);

  test('another key — a new migration — misses: the state is not the old one', async () => {
    const other = clientFor('m2');
    try {
      expect(await other.restoredDataSnapshot()).toBe(false);
      expect(await tableExists(other)).toBe(false);
    } finally {
      await other.close();
    }
  }, 60_000);

  test('the cache keeps the newest keys only', async () => {
    for (const key of ['m3', 'm4']) {
      const client = clientFor(key, 0);
      try {
        await client.ping();
        expect(await client.saveDataSnapshot()).toBe(true);
      } finally {
        await client.close();
      }
    }
    // m1, m3 and m4 were written; keeping none besides the newest leaves m4 alone.
    expect(readdirSync(dir).filter((name) => name.endsWith('.snapshot'))).toEqual([
      `pglite-${snapshotKey(VERSION)}-m4.snapshot`,
    ]);
  }, 60_000);
});
