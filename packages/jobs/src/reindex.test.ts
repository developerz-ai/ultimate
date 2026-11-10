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
  };
};

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
