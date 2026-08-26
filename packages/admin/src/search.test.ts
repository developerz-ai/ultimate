// What `search.ts` promises, driven over a real `entity()` result: the text fields the entity
// declared are the index — no second search config to drift from them — and the one query per
// field is declared to the runtime rather than only to the reader, so a statement diagnostic can
// tell this loop from an N+1 nobody argued for.

import { afterAll, describe, expect, test } from 'bun:test';
import { expectedQueryLoopReason } from '@ultimat3/db';
import { clearRegistry, entity, enumerated, newId, text, uuid } from '@ultimat3/entity';
import { defineAdmin } from './admin';
import { memoryAuditLog } from './audit';
import { type AdminActor, staticAuthz } from './authz';
import type { CrudCtx } from './crud';
import type { AdminRepo, AdminRow } from './registry';
import { adminSearch } from './search';

// `title` is text and `body` is a textarea, so the entity declares exactly two searchable fields —
// which is what makes "one lookup per field" a countable claim below.
const posts = entity('admin_search_post', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 120 }),
    body: text(),
    status: enumerated(['draft', 'published']).default('draft'),
  },
});

afterAll(clearRegistry);

const POST_ID = newId();

const row = (over: AdminRow = {}): AdminRow => ({
  id: POST_ID,
  title: 'First post',
  body: 'Body',
  status: 'draft',
  ...over,
});

function repoOver(store: Map<string, AdminRow>): AdminRepo<AdminRow> {
  return {
    list: async (): Promise<readonly AdminRow[]> => [...store.values()],
    find: async (id): Promise<AdminRow | null> => store.get(id) ?? null,
    create: async (input): Promise<AdminRow> => {
      const created = { ...input, id: String(input['id'] ?? newId()) };
      store.set(String(created['id']), created);
      return created;
    },
    update: async (id, patch): Promise<AdminRow> => {
      const next = { ...(store.get(id) ?? {}), ...patch };
      store.set(id, next);
      return next;
    },
    destroy: async (id): Promise<void> => void store.delete(id),
  };
}

const actor: AdminActor = { id: 'u_1' };
const GRANTS = ['admin:write', 'admin_search_post:read', 'admin_search_post:write'];

const adminOver = (repo: AdminRepo<AdminRow>) =>
  defineAdmin({
    entities: [posts],
    resources: { admin_search_post: { repo } },
    auth: { actor: (): AdminActor => actor, authz: staticAuthz(GRANTS) },
  });

const ctx = (): CrudCtx => ({
  actor,
  authz: staticAuthz(GRANTS),
  audit: memoryAuditLog(),
  requestId: 'req_1',
});

describe('adminSearch over an entity the admin derived', () => {
  test('search uses the text fields the entity declared', async () => {
    const app = adminOver(repoOver(new Map([[POST_ID, row()]])));
    const found = await adminSearch({
      term: 'First',
      resources: [app.resource('admin_search_post')],
      ctx: ctx(),
    });

    expect(found.searched).toEqual(['admin_search_post']);
    expect(found.hits.map((hit) => hit.label)).toEqual(['First post']);
  });

  // One indexed lookup per text field is the argued-for shape, and the argument is declared to
  // the runtime: a statement diagnostic must be able to tell this loop from an unconsidered N+1.
  test('search declares its per-field loop, and the scope ends with it', async () => {
    const store = new Map([[POST_ID, row()]]);
    const reasons: (string | undefined)[] = [];
    const app = adminOver({
      ...repoOver(store),
      list: async (): Promise<readonly AdminRow[]> => {
        reasons.push(expectedQueryLoopReason());
        return [...store.values()];
      },
    });

    const found = await adminSearch({
      term: 'First',
      resources: [app.resource('admin_search_post')],
      ctx: ctx(),
    });

    expect(found.hits).toHaveLength(1);
    // Two text fields, two lookups, both carrying the reason the loop is optimal.
    expect(reasons).toHaveLength(2);
    expect(reasons.every((reason) => reason?.includes('one indexed lookup per text field'))).toBe(
      true,
    );
    expect(expectedQueryLoopReason()).toBeUndefined();
  });
});

// `permissions.ts` carries `audited: true` for `search` ("Never false"), `audit.ts` says denied
// attempts are logged too, and `CLAUDE.md` says "every admin operation is audited, reads
// included". Search read rows out of every readable entity and never touched `ctx.audit`.
describe('adminSearch is audited, allowed or refused', () => {
  test('an allowed search writes one entry per searched resource, keyed on the table', async () => {
    const app = adminOver(repoOver(new Map([[POST_ID, row()]])));
    const context = ctx();
    const found = await adminSearch({
      term: 'First',
      resources: [app.resource('admin_search_post')],
      ctx: context,
    });

    expect(found.audit.map((entry) => entry.operation)).toEqual(['search']);
    const entries = context.audit.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outcome).toBe('allowed');
    expect(entries[0]?.entity).toBe('admin_search_post');
    expect(entries[0]?.entityId).toBeNull();
    expect(entries[0]?.actor.id).toBe('u_1');
    expect(entries[0]?.requestId).toBe('req_1');
  });

  test('a refused resource leaves the record of the refusal, not just a skipped entry', async () => {
    const app = adminOver(repoOver(new Map([[POST_ID, row()]])));
    const context: CrudCtx = { ...ctx(), authz: staticAuthz([]) };
    const found = await adminSearch({
      term: 'First',
      resources: [app.resource('admin_search_post')],
      ctx: context,
    });

    expect(found.hits).toEqual([]);
    expect(found.skipped).toEqual([
      { entity: 'admin_search_post', reason: 'admin.search.skipped.forbidden' },
    ]);
    const entries = context.audit.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outcome).toBe('denied');
    expect(entries[0]?.operation).toBe('search');
    expect(entries[0]?.entity).toBe('admin_search_post');
    expect(found.audit).toEqual(entries);
  });

  test('an empty term decides nothing, so it logs nothing', async () => {
    const app = adminOver(repoOver(new Map([[POST_ID, row()]])));
    const context = ctx();
    const found = await adminSearch({
      term: '   ',
      resources: [app.resource('admin_search_post')],
      ctx: context,
    });

    expect(found.audit).toEqual([]);
    expect(context.audit.entries()).toEqual([]);
  });
});

describe('a resource skipped for a structural reason is not an authz event', () => {
  // A second entity with no text column at all: nothing to search, and nothing decided about.
  const counters = entity('admin_search_counter', {
    columns: { id: uuid().primaryKey(), status: enumerated(['on', 'off']).default('on') },
  });

  const appWithCounter = (repo: AdminRepo<AdminRow> | undefined) =>
    defineAdmin({
      entities: [posts, counters],
      resources: {
        admin_search_post: { repo: repoOver(new Map([[POST_ID, row()]])) },
        ...(repo === undefined ? {} : { admin_search_counter: { repo } }),
      },
      auth: {
        actor: (): AdminActor => actor,
        authz: staticAuthz([...GRANTS, 'admin_search_counter:read']),
      },
    });

  const searchBoth = async (
    repo: AdminRepo<AdminRow> | undefined,
  ): Promise<Awaited<ReturnType<typeof adminSearch>> & { readonly logged: number }> => {
    const app = appWithCounter(repo);
    const context = {
      actor,
      authz: staticAuthz([...GRANTS, 'admin_search_counter:read']),
      audit: memoryAuditLog(),
      requestId: 'req_skip',
    };
    const found = await adminSearch({
      term: 'First',
      resources: [app.resource('admin_search_post'), app.resource('admin_search_counter')],
      ctx: context,
    });
    return { ...found, logged: context.audit.entries().length };
  };

  test('a resource with no text field is skipped, and writes NO audit entry', async () => {
    const found = await searchBoth(repoOver(new Map()));

    expect(found.searched).toEqual(['admin_search_post']);
    expect(found.skipped).toEqual([
      { entity: 'admin_search_counter', reason: 'admin.search.skipped.no-text-fields' },
    ]);
    // Exactly one entry: the resource that WAS read. Logging the skip would put a denial in an
    // auditor's face for a resource nobody was refused.
    expect(found.logged).toBe(1);
    expect(found.audit.map((entry) => entry.entity)).toEqual(['admin_search_post']);
  });

  test('a resource WITH text fields but no repo is skipped for that reason, and writes nothing', async () => {
    // Same entity, no repo bound: searchable in principle, with nothing to ask.
    const app = defineAdmin({
      entities: [posts],
      auth: { actor: (): AdminActor => actor, authz: staticAuthz(GRANTS) },
    });
    const context = ctx();
    const found = await adminSearch({
      term: 'First',
      resources: [app.resource('admin_search_post')],
      ctx: context,
    });

    expect(found.searched).toEqual([]);
    expect(found.skipped).toEqual([
      { entity: 'admin_search_post', reason: 'admin.search.skipped.no-repo' },
    ]);
    // Not an authorization event: the actor was allowed, there was simply nowhere to look.
    expect(found.audit).toEqual([]);
    expect(context.audit.entries()).toEqual([]);
  });
});

/**
 * The per-resource cap, when it is not a number. `??` guards nullish and `NaN` is not nullish, so
 * an `input.limitPerResource` computed from an environment value or an untyped config walks past
 * `DEFAULT_LIMIT_PER_RESOURCE` and reaches BOTH consumers intact: `hits.length >= NaN` is false, so
 * the early return never fires and every searchable field of every resource is queried; and
 * `repo.list({ limit: NaN })` hands the repo a limit no `LIMIT` clause can carry.
 */
describe('adminSearch · a per-resource limit that is not a number is not a limit', () => {
  const NOT_A_BOUND = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

  const twoRows = (): Map<string, AdminRow> =>
    new Map([
      ['p_1', row({ id: 'p_1' })],
      ['p_2', row({ id: 'p_2', title: 'First light' })],
    ]);

  test('a non-finite limit is refused, never accepted as "no cap"', async () => {
    const app = adminOver(repoOver(twoRows()));
    for (const limitPerResource of NOT_A_BOUND) {
      await expect(
        adminSearch({
          term: 'First',
          resources: [app.resource('admin_search_post')],
          ctx: ctx(),
          limitPerResource,
        }),
      ).rejects.toThrow('X_INVARIANT');
    }
  });

  test('a limit of 0 is refused — a search that may return nothing is not a search', async () => {
    const app = adminOver(repoOver(twoRows()));
    await expect(
      adminSearch({
        term: 'First',
        resources: [app.resource('admin_search_post')],
        ctx: ctx(),
        limitPerResource: 0,
      }),
    ).rejects.toThrow('X_INVARIANT');
  });

  test('the cap the caller passed is still what stops the walk', async () => {
    const seen: (number | undefined)[] = [];
    const base = repoOver(twoRows());
    const repo: AdminRepo<AdminRow> = {
      ...base,
      list: async (query): Promise<readonly AdminRow[]> => {
        seen.push(query.limit);
        return base.list(query);
      },
    };
    const found = await adminSearch({
      term: 'First',
      resources: [adminOver(repo).resource('admin_search_post')],
      ctx: ctx(),
      limitPerResource: 1,
    });
    expect(found.hits.length).toBe(1);
    expect(seen).toEqual([1]);
  });
});
