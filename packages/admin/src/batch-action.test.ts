// `batch` on an action: one run per selected row through the SAME gate as the button, each row
// audited, an honest count back — and above a DECLARED threshold, one `admin.batch` job per chunk
// that a worker runs through that same gate, as the operator who queued it.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createContext, UltimateError } from '@ultimat3/core';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { registerCatalog } from '@ultimat3/i18n';
import {
  createMemoryDriver,
  createWorker,
  getJob,
  type JobDriver,
  resetJobDriver,
  setJobDriver,
} from '@ultimat3/jobs';
import type { AdminApp } from './admin';
import { type AdminAuthz, allowed, denied } from './authz';
import type { BatchEnqueue } from './batch';
import type { AdminAction, AdminRow } from './registry';
import type { AdminResource } from './resource';

const { defineAdmin } = await import('./admin');
const { MAX_BATCH_ROWS, batchConfirmationToken, runAdminBatch } = await import('./batch');
const { ADMIN_BATCH_JOB, runBatchChunk } = await import('./batch-job');
const { callAdminTool } = await import('./mcp');

const items = entity('admin_batch_items', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 80 }),
    state: text({ max: 16 }),
  },
});

const db = database({ items }, { driver: memoryDriver() });

/** Every permission granted — except to a row titled "locked", which the POLICY refuses. */
const rowRule: AdminAuthz = {
  decide: ({ permission, subject }) => {
    const row = subject?.row as AdminRow | undefined | null;
    return row !== undefined && row !== null && row['title'] === 'locked'
      ? denied(permission, 'probe.locked-row')
      : allowed(permission, 'probe.granted');
  },
};

const ran: string[] = [];
const activate: AdminAction = {
  name: 'item.activate',
  permission: 'admin_batch_items:write',
  entity: 'admin_batch_items',
  when: (row) => row['state'] !== 'active',
  batch: true,
  handle: async ({ input }) => {
    const id = String(input['id']);
    const row = await db.items.where({ id }).one();
    // A handler failing is INPUT to the batch, thrown as an app would throw it.
    if (row?.title === 'explodes') {
      throw new UltimateError({
        code: 'X_ADMIN_INVALID',
        cause: 'handler blew up',
        fix: 'x manifest',
      });
    }
    ran.push(id);
  },
};
const purge: AdminAction = {
  name: 'item.purge',
  permission: 'admin_batch_items:delete',
  entity: 'admin_batch_items',
  destructive: true,
  batch: true,
  handle: async ({ input }) => {
    ran.push(`purge:${String(input['id'])}`);
  },
};
const archive: AdminAction = {
  name: 'item.archive',
  permission: 'admin_batch_items:write',
  entity: 'admin_batch_items',
  batch: { threshold: 2, chunk: 2 },
  handle: async ({ input }) => {
    ran.push(`archive:${String(input['id'])}`);
  },
};

let admin: AdminApp;
let jobs: JobDriver;
let resource: AdminResource;
beforeAll(() => {
  admin = defineAdmin({
    basePath: '/batch',
    entities: [items],
    db,
    actions: [activate, purge, archive],
    auth: { authz: rowRule },
  });
  resource = admin.resource('admin_batch_items');
});

registerCatalog('en', { 'admin.admin_batch_items.title': 'Items' });

const ctx = () => admin.ctx({ actor: { id: 'u-op', roles: ['ops'] }, requestId: 'batch' });
const insert = async (title: string, state = 'idle'): Promise<string> =>
  String((await db.items.insert({ title, state })).id);

beforeAll(() => {
  jobs = createMemoryDriver();
  setJobDriver(jobs);
});

beforeEach(() => {
  ran.length = 0;
});

afterAll(async () => {
  resetJobDriver();
  await jobs.close?.();
  clearRegistry();
});

describe('unit · a batch runs each row through the button’s gate', () => {
  test('3 rows, 1 refused by policy → 2 done, 1 refused, and 3 audit entries', async () => {
    const one = await insert('one');
    const two = await insert('two');
    const locked = await insert('locked');
    const context = ctx();
    const before = (await admin.audit.entries({ limit: 200 })).length;

    const result = await runAdminBatch({
      resource,
      action: activate,
      ctx: context,
      selection: { kind: 'ids', ids: [one, two, locked] },
    });

    expect(result).toMatchObject({ ok: true, done: 2, refused: 1, failed: 0, queued: 0 });
    expect(result.ok && result.rows).toEqual([
      { id: locked, outcome: 'refused', reason: 'probe.locked-row' },
    ]);
    expect(ran).toEqual([one, two]);
    const entries = (await admin.audit.entries({ limit: 200 })).slice(
      0,
      (await admin.audit.entries({ limit: 200 })).length - before,
    );
    const actionEntries = entries.filter((entry) => entry.operation === 'item.activate');
    expect(actionEntries.map((entry) => [entry.entityId, entry.outcome]).reverse()).toEqual([
      [one, 'allowed'],
      [two, 'allowed'],
      [locked, 'denied'],
    ]);
  });

  test('a row the action’s `when` excludes is refused by name, and a throw is failed — and neither stops the rest', async () => {
    const done = await insert('fine');
    const already = await insert('already', 'active');
    const boom = await insert('explodes');
    const after = await insert('after');
    const result = await runAdminBatch({
      resource,
      action: activate,
      ctx: ctx(),
      selection: { kind: 'ids', ids: [done, already, boom, after] },
    });
    expect(result).toMatchObject({ ok: true, done: 2, refused: 1, failed: 1 });
    expect(result.ok && result.rows).toEqual([
      { id: already, outcome: 'refused', reason: 'admin.error.action-not-applicable' },
      { id: boom, outcome: 'failed', reason: 'admin.error.action-failed' },
    ]);
    expect(ran).toEqual([done, after]);
  });

  test('an action that is not a batch action is refused the bar', async () => {
    const { batch: _batch, ...rest } = activate;
    const plain: AdminAction = { ...rest, name: 'item.plain' };
    const result = await runAdminBatch({
      resource,
      action: plain,
      ctx: ctx(),
      selection: { kind: 'ids', ids: [] },
    });
    expect(result).toMatchObject({ ok: false, kind: 'denied' });
  });

  test('a destructive batch asks for "<entity>:<n> rows" and runs only with it echoed', async () => {
    const a = await insert('pa');
    const b = await insert('pb');
    const selection = { kind: 'ids', ids: [a, b] } as const;
    const asked = await runAdminBatch({ resource, action: purge, ctx: ctx(), selection });
    expect(asked).toMatchObject({ ok: false, kind: 'confirm', count: 2 });
    expect(ran).toEqual([]);
    const token = batchConfirmationToken('admin_batch_items', 2);
    expect(token).toBe('admin_batch_items:2 rows');
    const run = await runAdminBatch({
      resource,
      action: purge,
      ctx: ctx(),
      selection,
      confirmation: token,
    });
    expect(run).toMatchObject({ ok: true, done: 2 });
  });
});

describe('unit · "all matching" is the list’s own filter, bounded per request', () => {
  test('every row the scope and filters match, never more than the bound, and how many remain', async () => {
    for (let at = 0; at < MAX_BATCH_ROWS + 3; at += 1) await insert(`bulk-${String(at)}`, 'bulk');
    const filter = { field: 'state', op: 'eq', value: 'bulk' } as const;
    const first = await runAdminBatch({
      resource,
      action: activate,
      ctx: ctx(),
      selection: { kind: 'all', request: { filters: [filter] } },
    });
    expect(first).toMatchObject({ ok: true, done: MAX_BATCH_ROWS, remaining: 3 });
    const after = first.ok ? first.after : null;
    if (after === null) return expect.unreachable('a batch with rows remaining names no position');
    const rest = await runAdminBatch({
      resource,
      action: activate,
      ctx: ctx(),
      selection: { kind: 'all', request: { filters: [filter] }, after },
    });
    expect(rest).toMatchObject({ ok: true, done: 3, remaining: 0, after: null });
    expect(new Set(ran).size).toBe(MAX_BATCH_ROWS + 3);
  });
});

describe('unit · above the declared threshold, one job per chunk', () => {
  test('5 rows over a threshold of 2 are queued as 3 chunks, counted queued, never done', async () => {
    const ids = await Promise.all(['q1', 'q2', 'q3', 'q4', 'q5'].map((title) => insert(title)));
    const chunks: Parameters<BatchEnqueue>[0][] = [];
    const enqueue: BatchEnqueue = async (chunk) => {
      chunks.push(chunk);
      return `job-${String(chunk.index)}`;
    };
    const result = await runAdminBatch({
      resource,
      action: archive,
      ctx: ctx(),
      selection: { kind: 'ids', ids },
      enqueue,
    });
    expect(result).toMatchObject({
      ok: true,
      done: 0,
      queued: 5,
      jobs: ['job-0', 'job-1', 'job-2'],
    });
    expect(chunks.map((chunk) => chunk.ids.length)).toEqual([2, 2, 1]);
    expect(ran).toEqual([]);
  });

  test('at or under the threshold it runs inline', async () => {
    const ids = await Promise.all(['i1', 'i2'].map((title) => insert(title)));
    const result = await runAdminBatch({
      resource,
      action: archive,
      ctx: ctx(),
      selection: { kind: 'ids', ids },
      enqueue: () => expect.unreachable('a batch under its threshold was queued'),
    });
    expect(result).toMatchObject({ ok: true, done: 2, queued: 0 });
  });

  test('declaring a threshold declares the `admin.batch` job; a worker runs the chunk as the operator', async () => {
    expect(getJob(ADMIN_BATCH_JOB)?.name).toBe(ADMIN_BATCH_JOB);
    const ids = await Promise.all(['w1', 'w2', 'w3'].map((title) => insert(title)));
    const result = await callAdminTool(admin, ctx(), 'admin.action.item.archive', { ids });
    expect(result).toMatchObject({ ok: true, data: { queued: 3 } });

    const worker = createWorker({
      driver: jobs,
      context: () => createContext({ role: 'worker' }),
      drainOnShutdown: false,
    });
    const executions = [...(await worker.tick()), ...(await worker.tick())];
    await worker.stop('test');
    expect(executions.map((execution) => execution.outcome)).toEqual(['completed', 'completed']);
    expect([...ran].sort()).toEqual(ids.map((id) => `archive:${id}`).sort());
    // Each row is audited when its chunk reaches it, as the operator who queued it.
    const archived = (await admin.audit.entries({ limit: 200 })).filter(
      (entry) => entry.operation === 'item.archive' && ids.includes(entry.entityId ?? ''),
    );
    expect(archived.map((entry) => entry.actor.id)).toEqual(['u-op', 'u-op', 'u-op']);
  });

  test('a chunk claimed where its admin was never declared is X_ADMIN_MOUNT_MISSING', async () => {
    await expect(
      runBatchChunk({
        basePath: '/nowhere',
        entity: 'admin_batch_items',
        action: 'item.archive',
        ids: [],
        input: '{}',
        batchId: 'b',
        index: 0,
        requestId: 'r',
        actor: { id: 'u', roles: [] },
      }),
    ).rejects.toBeUltimateError('X_ADMIN_MOUNT_MISSING');
  });

  test('a threshold that is not a count is refused where it is declared', () => {
    expect(() =>
      defineAdmin({
        basePath: '/batch-bad',
        entities: [items],
        db,
        actions: [{ ...archive, name: 'item.bad', batch: { threshold: Number.NaN } }],
      }),
    ).toThrow('X_INVARIANT');
  });

  test('a batch on a global action is refused: the bar is a list’s', () => {
    expect(() =>
      defineAdmin({
        basePath: '/batch-global',
        entities: [items],
        db,
        actions: [
          {
            name: 'everything',
            permission: 'admin_batch_items:write',
            batch: true,
            handle: async () => {},
          },
        ],
      }),
    ).toThrow(/declares batch with no entity/);
  });

  test('the refusal names the ACTION and its batch option, never a field of an entity "admin"', () => {
    let caught: unknown;
    try {
      defineAdmin({
        basePath: '/batch-global-text',
        entities: [items],
        db,
        actions: [
          {
            name: 'everything',
            permission: 'admin_batch_items:write',
            batch: true,
            handle: async () => {},
          },
        ],
      });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof UltimateError))
      return expect.unreachable('defineAdmin accepted a global batch');
    // The shipped code, unchanged; the text says what is wrong where it is written.
    expect(caught.code).toBe('X_ADMIN_FIELD_UNSUPPORTED');
    expect(caught.cause).toStartWith('defineAdmin.actions["everything"].batch:');
    expect(caught.cause).not.toContain('admin.everything');
    expect(caught.fix).toContain("entity: '<entity>'");
  });
});
