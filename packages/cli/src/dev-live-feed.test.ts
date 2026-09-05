// A live query under an `x dev` boot with the EMBEDDED database: the snapshot arrives, and then
// — until 2026-09-05 — nothing ever did, because PGlite has no walsender and no boot installed a
// row observer. This holds a real subscription on the real node and makes one repository write.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; the fixture is joined to this file's directory.
import { join } from 'node:path';
import { resetRegistry as resetActions } from '@ultimat3/action';
import { isolateDeclaredTags, resetTiers } from '@ultimat3/cache';
import { userActor } from '@ultimat3/core';
import { clearRegistry as clearEntities } from '@ultimat3/entity';
import { resetJobs, resetTasks } from '@ultimat3/jobs';
import { clearPermissions, clearRoles } from '@ultimat3/policy';
import { resetRegistry as resetQueries } from '@ultimat3/query';
import type { Frame } from '@ultimat3/realtime';
import { decode } from '@ultimat3/realtime';
import type { WsLike } from '@ultimat3/realtime/server';
import { SyncSocket } from '@ultimat3/realtime/server';
import { clearRoutes } from '@ultimat3/render';
import { resetAppLoad } from './app-load';
import type { DevServer } from './cmd-dev';
import { startDev } from './cmd-dev';
import { liveFeedLabel, startLiveFeed } from './dev-live-feed';

const ROOT = join(import.meta.dir, '..', '.dev-live-fixture');

const FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'dev-live-fixture', version: '1.0.0' }),
  'app.config.ts': `import { defineConfig } from '@ultimat3/core';
export const config = defineConfig({ name: 'dev-live-fixture' });
`,
  // The memory driver, so the fixture needs no migration: the observer sits on `database()`'s
  // repo wrapper, which is the same seam a Postgres-backed repo writes through.
  'apps/web/app/notes/entity.ts': `import { database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
export const notes = entity('notes', { columns: { id: uuid().primaryKey(), title: text() } });
export const db = database({ notes }, { driver: memoryDriver() });
`,
  'apps/web/app/notes/live.ts': `import { allow } from '@ultimat3/policy';
import { from, query, t } from '@ultimat3/query';
import { db } from './entity';
export const liveNotes = query({
  input: t.object({}),
  policy: allow('public'),
  live: true,
  subscribes: ['notes'],
  sql: () =>
    from<{ id: string; title: string }>('notes', () => db.notes.where({}).all())
      .orderBy('id')
      .limit(50),
});
`,
};

/** Booting embedded Postgres, the sync node and the HTTP role is seconds of real work. */
const BOOT_TIMEOUT_MS = 60_000;

class FakeWs implements WsLike {
  readonly frames: Frame[] = [];
  send(data: string): number {
    this.frames.push(decode(data));
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

const resetRegistries = (): void => {
  resetActions();
  resetQueries();
  clearEntities();
  clearRoutes();
  resetJobs();
  resetTasks();
  clearPermissions();
  clearRoles();
  resetAppLoad();
};

const restoreTags = isolateDeclaredTags();

let server: DevServer | undefined;

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(FILES)) await Bun.write(join(ROOT, path), contents);
  resetRegistries();
  server = await startDev({ root: ROOT, port: 0, env: {}, roles: ['web', 'sync'] });
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  try {
    await server?.stop();
    await rm(ROOT, { recursive: true, force: true });
  } finally {
    resetTiers();
    resetRegistries();
    restoreTags();
  }
}, BOOT_TIMEOUT_MS);

describe('the live feed under an embedded database', () => {
  test('is the in-process bridge, and the boot says so', () => {
    expect(server?.running.liveFeed).toBe('in-process');
    expect(liveFeedLabel('in-process')).toBe('live=in-process');
  });

  test('a repository write in this process reaches a subscriber as a patch', async () => {
    const registry = server?.running.liveRegistry ?? null;
    const bridge = server?.running.liveBridge ?? null;
    if (server === undefined || registry === null || bridge === null) {
      expect.unreachable('the sync role did not boot with a bridge');
    }
    const ws = new FakeWs();
    const socket = new SyncSocket({
      ws,
      clientBuildId: server.buildId,
      serverBuildId: server.buildId,
      actor: userActor({ id: 'u1' }),
    });
    const { frame } = await registry.subscribe({ socket, name: 'liveNotes', input: {} });
    expect(frame.type).toBe('snapshot');
    ws.frames.length = 0;

    const { db } = (await import(join(ROOT, 'apps/web/app/notes/entity.ts'))) as {
      db: { notes: { insert(row: { id: string; title: string }): Promise<unknown> } };
    };
    await db.notes.insert({ id: crypto.randomUUID(), title: 'first note' });
    await bridge.settled();

    expect(bridge.delivered).toBeGreaterThan(0);
    expect(ws.frames.map((sent) => sent.type)).toContain('patch');
  });
});

describe('startLiveFeed decides by the database, never by guessing', () => {
  test('no sync node is no feed; a real database is the WAL decoder, with no bridge beside it', async () => {
    expect((await startLiveFeed({ sync: null, dbMode: 'embedded' })).feed).toBe('none');
    const external = await startLiveFeed({
      sync: { url: 'ws://x', registry: {} as never, stop: async () => undefined },
      dbMode: 'external',
    });
    expect(external.feed).toBe('replication');
    expect(external.bridge).toBeNull();
  });
});
