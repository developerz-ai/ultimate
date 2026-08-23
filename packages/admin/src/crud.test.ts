// Proves the five CRUD operations from the outside: a denial is refused AND logged, a
// destructive delete refuses to run without its own confirmation token echoed back, and both
// the audit diff and the row actually persisted reflect only what validation approved — never
// the caller's raw, unvalidated input.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, money, newId, text, timestamp, uuid } from '@ultimat3/entity';
import { memoryAuditLog } from './audit';
import { type AdminActor, staticAuthz } from './authz';
import { adminCreate, adminDestroy, adminList, adminUpdate, type CrudCtx } from './crud';
import { confirmationToken } from './permissions';
import type { AdminRow } from './registry';
import { type AdminResource, adminResource } from './resource';

const post = entity('admin_crud_post', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 120 }),
    secret: text({ max: 64 }).nullable(),
    // `money()` stores `bigint` minor units, so a driver hands the row a bigint — which is what
    // `JSON.stringify` throws on. No fixture here had one, so the audit diff's stringify
    // comparison was green through every update in this file.
    price: money(),
    createdAt: timestamp().defaultNow(),
  },
});

afterAll(clearRegistry);

/** A real id: the update path validates the merged row against the entity's own schema. */
const POST_ID = newId();

type Repo = NonNullable<Parameters<typeof adminResource>[1]>['repo'];

function bound(
  store: Map<string, AdminRow>,
  over: Partial<NonNullable<Repo>> = {},
): AdminResource<AdminRow> {
  return adminResource(post, {
    // An entity has no secret flag; the admin is where a column is declared unreadable.
    fields: { secret: { sensitive: true } },
    repo: {
      list: async (): Promise<readonly AdminRow[]> => [...store.values()],
      // CLONED, as a driver's decode is: two reads of one row hand back two objects. Returning
      // the stored reference made `before.price === after.price` and short-circuited the audit
      // diff's value comparison, so no fixture here ever reached the branch that compares them.
      find: async (id: string): Promise<AdminRow | null> => {
        const row = store.get(id);
        return row === undefined ? null : structuredClone(row);
      },
      create: async (input): Promise<AdminRow> => {
        store.set(String(input['id']), input);
        return input;
      },
      update: async (id, patch): Promise<AdminRow> => {
        const next = { ...(store.get(id) ?? {}), ...patch };
        store.set(id, next);
        return next;
      },
      destroy: async (id): Promise<void> => void store.delete(id),
      ...over,
    },
  });
}

/** What a driver decoding a `money()` column hands back: minor units as a `bigint`. */
const PRICE = { minor: 1000n, currency: 'EUR' };

const actor: AdminActor = { id: 'u_1', roles: ['admin'] };

const ctxWith = (grants: readonly string[]): CrudCtx => ({
  actor,
  authz: staticAuthz(grants),
  audit: memoryAuditLog(),
  requestId: 'req_1',
});

// A read is an audited operation here, both ways. `audit.ts`: "if it isn't logged, it didn't
// happen — so denied and failed attempts are logged too". `adminList` was the one call that
// logged neither: an operator could walk a whole table, or be refused, and leave no row.
describe('listing is audited, allowed or not', () => {
  test('an allowed listing writes one entry keyed on the table, not on a row', async () => {
    const ctx = ctxWith(['admin:read', 'admin_crud_post:read']);
    const result = await adminList(bound(new Map()), ctx, {});

    expect(result.ok).toBe(true);
    const entries = await ctx.audit.entries();
    expect(entries.map((entry) => entry.operation)).toEqual(['list']);
    expect(entries[0]?.outcome).toBe('allowed');
    expect(entries[0]?.entityId).toBeNull();
  });

  test('a refused listing leaves the record of the refusal', async () => {
    const ctx = ctxWith([]);
    const result = await adminList(bound(new Map()), ctx, {});

    expect(result.ok).toBe(false);
    const entries = await ctx.audit.entries();
    expect(entries.map((entry) => entry.outcome)).toEqual(['denied']);
    expect(entries[0]?.operation).toBe('list');
  });
});

describe('admin mutations are audited with a before/after diff', () => {
  test('update logs exactly the fields that changed', async () => {
    const store = new Map<string, AdminRow>([
      [
        POST_ID,
        {
          id: POST_ID,
          title: 'Draft',
          secret: 'old',
          price: PRICE,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
    ]);
    const ctx = ctxWith(['admin:write', 'admin_crud_post:write']);
    const result = await adminUpdate(bound(store), ctx, POST_ID, {
      title: 'Published',
      secret: 'new',
    });

    expect(result.ok).toBe(true);
    const entry = ctx.audit.entries()[0];
    expect(entry?.operation).toBe('update');
    expect(entry?.entityId).toBe(POST_ID);
    expect(entry?.actor.id).toBe('u_1');
    expect(entry?.requestId).toBe('req_1');
    expect(entry?.diff).toEqual([
      { field: 'secret', before: '[redacted]', after: '[redacted]' },
      { field: 'title', before: 'Draft', after: 'Published' },
    ]);
  });

  test('an undeclared field in the patch is validated away, never persisted', async () => {
    const store = new Map<string, AdminRow>([
      [
        POST_ID,
        { id: POST_ID, title: 'Draft', price: PRICE, createdAt: '2026-07-01T00:00:00.000Z' },
      ],
    ]);
    const ctx = ctxWith(['admin:write', 'admin_crud_post:write']);
    const result = await adminUpdate(bound(store), ctx, POST_ID, {
      title: 'Published',
      // Not a column of `post` — the entity's own schema drops it; the repo write must too.
      isAdmin: true,
    });

    expect(result.ok).toBe(true);
    expect(store.get(POST_ID)).toEqual({
      id: POST_ID,
      title: 'Published',
      price: PRICE,
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    expect(store.get(POST_ID)?.['isAdmin']).toBeUndefined();
  });

  test('a patch naming a prototype member reaches the repo with nothing extra', async () => {
    // Executed against the `key in parsed.value` filter this replaced: the patch handed to
    // `repo.update` was `{ title: 'ok', toString: [Function], constructor: [class Object],
    // __proto__: [Object: null prototype] {} }` — inherited members, past validation, into a write.
    const store = new Map<string, AdminRow>([
      [
        POST_ID,
        { id: POST_ID, title: 'Draft', price: PRICE, createdAt: '2026-07-01T00:00:00.000Z' },
      ],
    ]);
    const ctx = ctxWith(['admin:write', 'admin_crud_post:write']);
    const patch = JSON.parse(
      '{"title":"Published","toString":1,"constructor":2,"__proto__":3}',
    ) as Record<string, unknown>;

    const result = await adminUpdate(bound(store), ctx, POST_ID, patch);

    expect(result.ok).toBe(true);
    expect(Object.keys(store.get(POST_ID) ?? {}).sort()).toEqual([
      'createdAt',
      'id',
      'price',
      'title',
    ]);
    expect(store.get(POST_ID)?.['title']).toBe('Published');
  });

  test('a denied update writes nothing and still leaves a record', async () => {
    const store = new Map<string, AdminRow>([[POST_ID, { id: POST_ID, title: 'Draft' }]]);
    const ctx = ctxWith(['admin:read']);
    const result = await adminUpdate(bound(store), ctx, POST_ID, { title: 'Hijacked' });

    expect(result.ok).toBe(false);
    expect(store.get(POST_ID)).toEqual({ id: POST_ID, title: 'Draft' });
    expect(ctx.audit.entries()[0]?.outcome).toBe('denied');
  });
});

describe('destructive operations re-confirm', () => {
  test('delete without the confirmation token is refused and logged', async () => {
    const store = new Map<string, AdminRow>([[POST_ID, { id: POST_ID, title: 'Draft' }]]);
    const ctx = ctxWith(['admin:destroy', 'admin_crud_post:delete']);
    const refused = await adminDestroy(bound(store), ctx, POST_ID, undefined);

    expect(refused.ok).toBe(false);
    if (!refused.ok && refused.kind === 'denied') {
      expect(refused.confirmationRequired).toBe(true);
      expect(refused.decision.reason).toBe('admin.error.confirmation-required');
    }
    expect(store.has(POST_ID)).toBe(true);
    expect(ctx.audit.entries()[0]?.outcome).toBe('denied');
  });

  test('delete with the token removes the row and logs the before state', async () => {
    const store = new Map<string, AdminRow>([[POST_ID, { id: POST_ID, title: 'Draft' }]]);
    const ctx = ctxWith(['admin:destroy', 'admin_crud_post:delete']);
    const result = await adminDestroy(bound(store), ctx, POST_ID, `admin_crud_post:${POST_ID}`);

    expect(result.ok).toBe(true);
    expect(store.has(POST_ID)).toBe(false);
    const entry = ctx.audit.entries()[0];
    expect(entry?.outcome).toBe('allowed');
    expect(entry?.diff).toEqual([
      { field: 'id', before: POST_ID, after: undefined },
      { field: 'title', before: 'Draft', after: undefined },
    ]);
  });
});

/**
 * `AuditOutcome` declares a `failed` member and `crud.ts` emitted it in exactly ONE place — the
 * `invalid()` path, for a validation issue. A constraint violation, a statement that timed out
 * after committing, a dropped connection mid-write: none of them left an entry at all, which is
 * precisely the case an auditor is reading the log for. Both siblings already do it and each
 * states the rule — `search.ts` ("appended BEFORE the read, so a repo that throws still leaves
 * the record that the rows were asked for") and `action-gate.ts`.
 *
 * A mutation cannot append first the way a read does: that would record a write that may never
 * have happened. So the write is wrapped, the failure is recorded, and the error is re-thrown
 * UNCHANGED — the caller owns it, and nothing about it is rendered into the entry.
 */
describe('a repo that throws leaves a failed entry and the error intact', () => {
  const boom = (): Promise<never> =>
    Promise.reject(new Error('duplicate key value violates unique constraint'));

  const seeded = (): Map<string, AdminRow> =>
    new Map<string, AdminRow>([
      [
        POST_ID,
        { id: POST_ID, title: 'Draft', price: PRICE, createdAt: '2026-07-01T00:00:00.000Z' },
      ],
    ]);

  test('update records the failure, then re-throws', async () => {
    const ctx = ctxWith(['admin:write', 'admin_crud_post:write']);
    const resource = bound(seeded(), { update: boom });

    await expect(adminUpdate(resource, ctx, POST_ID, { title: 'Published' })).rejects.toThrow(
      /duplicate key/,
    );
    const entries = ctx.audit.entries();
    expect(entries.map((entry) => [entry.operation, entry.outcome])).toEqual([
      ['update', 'failed'],
    ]);
    expect(entries[0]?.entityId).toBe(POST_ID);
    // Never the thrown value: an audit reason is a key or a rule name, not a database message.
    expect(entries[0]?.reason).toBe('admin.audit.write-failed');
    expect(entries[0]?.diff).toEqual([]);
  });

  test('create records the failure, then re-throws', async () => {
    const ctx = ctxWith(['admin:write', 'admin_crud_post:write']);
    const resource = bound(new Map(), { create: boom });

    await expect(
      adminCreate(resource, ctx, {
        id: POST_ID,
        title: 'Draft',
        price: { minor: 1000, currency: 'EUR' },
        createdAt: '2026-07-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/duplicate key/);
    expect(ctx.audit.entries().map((entry) => [entry.operation, entry.outcome])).toEqual([
      ['create', 'failed'],
    ]);
  });

  test('delete records the failure, then re-throws', async () => {
    const ctx = ctxWith(['admin:destroy', 'admin_crud_post:delete']);
    const resource = bound(seeded(), { destroy: boom });

    await expect(
      adminDestroy(resource, ctx, POST_ID, confirmationToken('admin_crud_post', POST_ID)),
    ).rejects.toThrow(/duplicate key/);
    expect(ctx.audit.entries().map((entry) => [entry.operation, entry.outcome])).toEqual([
      ['delete', 'failed'],
    ]);
  });
});
