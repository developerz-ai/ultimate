// Proves the five CRUD operations from the outside: a denial is refused AND logged, a
// destructive delete refuses to run without its own confirmation token echoed back, and both
// the audit diff and the row actually persisted reflect only what validation approved — never
// the caller's raw, unvalidated input.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, newId, text, timestamp, uuid } from '@ultimat3/entity';
import { memoryAuditLog } from './audit';
import { type AdminActor, staticAuthz } from './authz';
import { adminDestroy, adminList, adminUpdate, type CrudCtx } from './crud';
import type { AdminRow } from './registry';
import { type AdminResource, adminResource } from './resource';

const post = entity('admin_crud_post', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 120 }),
    secret: text({ max: 64 }).nullable(),
    createdAt: timestamp().defaultNow(),
  },
});

afterAll(clearRegistry);

/** A real id: the update path validates the merged row against the entity's own schema. */
const POST_ID = newId();

function bound(store: Map<string, AdminRow>): AdminResource<AdminRow> {
  return adminResource(post, {
    // An entity has no secret flag; the admin is where a column is declared unreadable.
    fields: { secret: { sensitive: true } },
    repo: {
      list: async (): Promise<readonly AdminRow[]> => [...store.values()],
      find: async (id: string): Promise<AdminRow | null> => store.get(id) ?? null,
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
    },
  });
}

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
        { id: POST_ID, title: 'Draft', secret: 'old', createdAt: '2026-07-01T00:00:00.000Z' },
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
      [POST_ID, { id: POST_ID, title: 'Draft', createdAt: '2026-07-01T00:00:00.000Z' }],
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
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    expect(store.get(POST_ID)?.['isAdmin']).toBeUndefined();
  });

  test('a patch naming a prototype member reaches the repo with nothing extra', async () => {
    // Executed against the `key in parsed.value` filter this replaced: the patch handed to
    // `repo.update` was `{ title: 'ok', toString: [Function], constructor: [class Object],
    // __proto__: [Object: null prototype] {} }` — inherited members, past validation, into a write.
    const store = new Map<string, AdminRow>([
      [POST_ID, { id: POST_ID, title: 'Draft', createdAt: '2026-07-01T00:00:00.000Z' }],
    ]);
    const ctx = ctxWith(['admin:write', 'admin_crud_post:write']);
    const patch = JSON.parse(
      '{"title":"Published","toString":1,"constructor":2,"__proto__":3}',
    ) as Record<string, unknown>;

    const result = await adminUpdate(bound(store), ctx, POST_ID, patch);

    expect(result.ok).toBe(true);
    expect(Object.keys(store.get(POST_ID) ?? {}).sort()).toEqual(['createdAt', 'id', 'title']);
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
