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
