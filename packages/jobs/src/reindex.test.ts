// `reindex()` run by `executeJob` over a memory table: every row reaches the index as entity's own
// document (searchable columns only, its tenant kept), batch by batch; an entity with nothing
// searchable is refused where it was declared.

import { afterEach, describe, expect, test } from 'bun:test';
import { ctxOf, isUltimateError, userActor } from '@ultimat3/core';
import type { SearchDocument, SearchIndex } from '@ultimat3/entity';
import {
  clearRegistry,
  entity,
  memoryRepo,
  memorySearchIndex,
  tableFor,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import type { ClaimedJob } from './driver';
import { memoryJobDriver } from './driver-memory';
import { executeJob } from './execute';
import type { AnyJobHandle } from './job';
import { resetJobs } from './job';
import { reindex } from './reindex';

const ORG_A = '00000000-0000-7000-8000-0000000000a1';
const ORG_B = '00000000-0000-7000-8000-0000000000b2';

const posts = entity('reindex_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid(),
    title: text().searchable('A'),
    secret: text(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
});
const unversioned = entity('reindex_unversioned', {
  columns: { id: uuid().primaryKey(), title: text().searchable() },
});

const labels = entity('reindex_labels', {
  columns: {
    orgId: uuid(),
    name: text(),
    title: text().searchable(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
  primaryKey: ['orgId', 'name'],
});

/** A partitioned table's shape: the instant is in the key. */
const events = entity('reindex_events', {
  columns: {
    id: uuid(),
    at: timestamp(),
    title: text().searchable(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
  primaryKey: ['id', 'at'],
});

const AT = new Date('2026-11-09T10:00:00.000Z');
const plain = entity('reindex_plain', { columns: { id: uuid().primaryKey(), note: text() } });

const rows = [1, 2, 3].map((n) => ({
  id: `00000000-0000-7000-8000-00000000000${n}`,
  orgId: n === 3 ? ORG_B : ORG_A,
  title: `post ${n}`,
  secret: 'never indexed',
  updatedAt: new Date(AT.getTime() + n),
}));

const recording = (): SearchIndex & { readonly calls: SearchDocument[][] } => {
  const calls: SearchDocument[][] = [];
  return {
    name: 'recording',
    calls,
    index: async (documents) => {
      calls.push([...documents]);
    },
    remove: async () => undefined,
    query: async () => [],
    list: async () => ({ entries: [], next: null }),
  };
};

/** One `posts` document as the index would hold it: tenant, id, version and its text. */
const held = (
  id: string,
  orgId: string,
  title: string,
  version = AT.getTime(),
): SearchDocument => ({
  entity: 'reindex_posts',
  tenant: orgId,
  id,
  version,
  fields: { title },
});

const STALE = '00000000-0000-7000-8000-0000000000ff';

afterEach(() => {
  resetJobs();
  clearRegistry();
});

const run = async (handle: AnyJobHandle) => {
  const driver = memoryJobDriver();
  await driver.enqueue({
    name: handle.name,
    queue: handle.queue,
    input: {},
    idempotencyKey: handle.name,
    maxAttempts: 1,
  });
  const [claimed] = await driver.claim({
    queues: [handle.queue],
    limit: 1,
    visibilityTimeoutMs: 30_000,
    workerId: 'w1',
  });
  const ctx = ctxOf({ role: 'worker', actor: userActor({ id: 'worker-1' }) });
  return executeJob({ driver, claimed: claimed as ClaimedJob, handle, ctx });
};

describe('reindex()', () => {
  test('every row reaches the index as its document, one call per batch', async () => {
    const index = recording();
    const handle = reindex({
      name: 'reindex-posts',
      entity: posts,
      tenant: 'none',
      batch: 2,
      rate: 1_000,
      source: () => tableFor(posts, memoryRepo(posts, rows)),
      index: () => index,
    });
    const execution = await run(handle as AnyJobHandle);
    expect(execution.outcome).toBe('completed');
    expect(index.calls.map((batch) => batch.length)).toEqual([2, 1]);
    expect(index.calls.flat()).toEqual(
      rows.map((row) => ({
        entity: 'reindex_posts',
        tenant: row.orgId,
        id: row.id,
        version: row.updatedAt.getTime(),
        fields: { title: row.title },
      })),
    );
  });

  test('the sweep removes every indexed id the table no longer holds, each tenant its own', async () => {
    const index = memorySearchIndex();
    const [first] = rows;
    await index.index([
      held(STALE, ORG_A, 'post gone'),
      held(STALE, ORG_B, 'post gone'),
      // A row the table holds under ORG_A, indexed under ORG_B: that entry is stale too.
      held(first?.id ?? '', ORG_B, 'post moved'),
    ]);
    const handle = reindex({
      name: 'reindex-posts-sweep',
      entity: posts,
      tenant: 'none',
      batch: 2,
      rate: 1_000,
      source: () => tableFor(posts, memoryRepo(posts, rows)),
      index: () => index,
    });
    const execution = await run(handle as AnyJobHandle);
    expect(execution.outcome).toBe('completed');
    const ids = async (tenant: string) =>
      (await index.query({ entity: 'reindex_posts', tenant, term: 'post' }))
        .map((hit) => hit.id)
        .sort();
    expect<(string | undefined)[]>(await ids(ORG_A)).toEqual([rows[0]?.id, rows[1]?.id]);
    expect<(string | undefined)[]>(await ids(ORG_B)).toEqual([rows[2]?.id]);
  });

  test('a document indexed after the sweep listed it, newer than it, survives', async () => {
    const index = memorySearchIndex();
    await index.index([held(STALE, ORG_A, 'post gone', 10)]);
    const racing: SearchIndex = {
      ...index,
      list: async (query) => {
        const page = await index.list(query);
        // The id is written again between the sweep's list and its removal.
        await index.index([held(STALE, ORG_A, 'post back', 20)]);
        return page;
      },
    };
    const handle = reindex({
      name: 'reindex-posts-race',
      entity: posts,
      tenant: 'none',
      rate: 1_000,
      source: () => tableFor(posts, memoryRepo(posts, [])),
      index: () => racing,
    });
    expect((await run(handle as AnyJobHandle)).outcome).toBe('completed');
    const hits = await index.query({ entity: 'reindex_posts', tenant: ORG_A, term: 'back' });
    expect(hits).toEqual([{ id: STALE }]);
  });

  test('the sweep reads a composite key back out of its index id', async () => {
    const index = memorySearchIndex();
    const live = { orgId: ORG_A, name: 'red', title: 'label red', updatedAt: AT };
    const doc = (name: string): SearchDocument => ({
      entity: 'reindex_labels',
      tenant: ORG_A,
      id: JSON.stringify([ORG_A, name]),
      version: AT.getTime(),
      fields: { title: `label ${name}` },
    });
    await index.index([doc('red'), doc('blue')]);
    const handle = reindex({
      name: 'reindex-labels',
      entity: labels,
      tenant: 'none',
      rate: 1_000,
      source: () => tableFor(labels, memoryRepo(labels, [live])),
      index: () => index,
    });
    expect((await run(handle as AnyJobHandle)).outcome).toBe('completed');
    const hits = await index.query({ entity: 'reindex_labels', tenant: ORG_A, term: 'label' });
    expect(hits).toEqual([{ id: JSON.stringify([ORG_A, 'red']) }]);
  });

  test('the sweep keeps a live row whose key holds an instant', async () => {
    const index = memorySearchIndex();
    const live = { id: rows[0]?.id ?? '', at: AT, title: 'event live', updatedAt: AT };
    const doc = (at: Date): SearchDocument => ({
      entity: 'reindex_events',
      tenant: null,
      id: JSON.stringify([live.id, at.toISOString()]),
      version: AT.getTime(),
      fields: { title: 'event' },
    });
    await index.index([doc(AT), doc(new Date(AT.getTime() + 1))]);
    const handle = reindex({
      name: 'reindex-events',
      entity: events,
      tenant: 'none',
      rate: 1_000,
      source: () => tableFor(events, memoryRepo(events, [live])),
      index: () => index,
    });
    expect((await run(handle as AnyJobHandle)).outcome).toBe('completed');
    const hits = await index.query({ entity: 'reindex_events', tenant: null, term: 'event' });
    expect(hits).toEqual([{ id: JSON.stringify([live.id, AT.toISOString()]) }]);
  });

  test('an entity with no searchable column is refused at declaration', () => {
    let thrown: unknown;
    try {
      reindex({
        name: 'reindex-plain',
        entity: plain,
        tenant: 'none',
        source: () => tableFor(plain, memoryRepo(plain, [])),
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(isUltimateError(thrown) ? thrown.code : undefined).toBe('X_INVARIANT');
  });

  test("a batch that is not a whole count of at least one is refused as reindex()'s own", () => {
    for (const batch of [0, 1.5, Number.NaN]) {
      let thrown: unknown;
      try {
        reindex({
          name: 'reindex-bad-batch',
          entity: posts,
          tenant: 'none',
          batch,
          source: () => tableFor(posts, memoryRepo(posts, [])),
        });
      } catch (error: unknown) {
        thrown = error;
      }
      expect(isUltimateError(thrown) ? thrown.cause : undefined).toContain(
        'reindex "reindex-bad-batch" batch',
      );
    }
  });

  test('an entity with no onUpdateNow() version is refused at declaration', () => {
    let thrown: unknown;
    try {
      reindex({
        name: 'reindex-unversioned',
        entity: unversioned,
        tenant: 'none',
        source: () => tableFor(unversioned, memoryRepo(unversioned, [])),
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(isUltimateError(thrown) ? thrown.code : undefined).toBe('X_INVARIANT_VIOLATED');
  });
});
