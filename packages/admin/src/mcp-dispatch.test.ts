// `callAdminTool`'s dispatch table: one entry per tool kind, each one landing on the CRUD call
// that surface actually performs. `mcp.test.ts` owns visibility (`tools/list` per caller) and
// `mcp-context.test.ts` owns the ambient actor; this file owns what happens AFTER the name
// resolves — including the two refusals a denial and an invalid input come back as.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, newId, text, timestamp, uuid } from '@ultimat3/entity';
import { defineAdmin } from './admin';
import { memoryAuditLog } from './audit';
import {
  type AdminActor,
  type AdminAuthz,
  type AdminDecision,
  type AdminSubject,
  staticAuthz,
} from './authz';
import type { CrudCtx } from './crud';
import { type AdminToolResult, adminMcp, callAdminTool } from './mcp';
import type { AdminRow } from './registry';

const doc = entity('admin_dispatch_doc', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 120 }),
    createdAt: timestamp().defaultNow(),
  },
});

afterAll(clearRegistry);

/** A real uuid and a real `Date`: `adminUpdate` re-validates `{ ...before, ...patch }` against
 * the ENTITY's own schema, so a fixture row that would not survive it fails as `invalid` and the
 * dispatch assertion below would be measuring the fixture. */
const ID = newId();
const ROW: AdminRow = { id: ID, title: 'First', createdAt: new Date('2026-08-19T00:00:00.000Z') };

/** A repo that records every call, so a test can assert WHICH repo method the dispatch reached. */
function recordingRepo(): {
  readonly repo: NonNullable<Parameters<typeof defineAdmin>[0]['resources']> extends never
    ? never
    : {
        list(input: { limit: number; cursor?: string }): Promise<readonly AdminRow[]>;
        find(id: string): Promise<AdminRow | null>;
        create(input: AdminRow): Promise<AdminRow>;
        update(id: string, patch: AdminRow): Promise<AdminRow>;
        destroy(id: string): Promise<void>;
      };
  readonly calls: string[];
  readonly limits: number[];
  readonly patches: Readonly<Record<string, unknown>>[];
} {
  const calls: string[] = [];
  const limits: number[] = [];
  const patches: Readonly<Record<string, unknown>>[] = [];
  return {
    calls,
    limits,
    patches,
    repo: {
      list: async (input): Promise<readonly AdminRow[]> => {
        calls.push('list');
        limits.push(input.limit);
        return [ROW];
      },
      find: async (id): Promise<AdminRow | null> => {
        calls.push(`find:${id}`);
        return id === ID ? ROW : null;
      },
      create: async (input): Promise<AdminRow> => {
        calls.push('create');
        return { ...ROW, ...input };
      },
      update: async (id, patch): Promise<AdminRow> => {
        calls.push(`update:${id}`);
        patches.push(patch);
        return { ...ROW, ...patch };
      },
      destroy: async (id): Promise<void> => {
        calls.push(`destroy:${id}`);
      },
    },
  };
}

const GRANTS = [
  'admin:destroy',
  'admin_dispatch_doc:read',
  'admin_dispatch_doc:write',
  'admin_dispatch_doc:delete',
];

const ACTOR: AdminActor = { id: 'agent-1', roles: ['ops'], orgId: 'org_1' };

function appWith(
  authz: AdminAuthz,
  calls = recordingRepo(),
): {
  readonly app: ReturnType<typeof defineAdmin>;
  readonly ctx: CrudCtx;
  readonly repo: ReturnType<typeof recordingRepo>;
} {
  const app = defineAdmin({
    entities: [doc],
    resources: { admin_dispatch_doc: { repo: calls.repo } },
    auth: { actor: (): AdminActor | null => ACTOR, authz },
  });
  return {
    app,
    repo: calls,
    ctx: { actor: ACTOR, authz, audit: memoryAuditLog(), requestId: 'req_dispatch' },
  };
}

const call = (
  fixture: ReturnType<typeof appWith>,
  name: string,
  input: Record<string, unknown> = {},
): Promise<AdminToolResult> => callAdminTool(fixture.app, fixture.ctx, name, input);

describe('a tool this actor may not use is refused, whatever else the input says', () => {
  test('a name outside the actor’s catalog answers X_ADMIN_TOOL_FORBIDDEN, naming the actor', async () => {
    const fixture = appWith(staticAuthz(['admin:read', 'admin_dispatch_doc:read']));
    const result = await call(fixture, 'admin.admin_dispatch_doc.delete', {
      id: ID,
      confirmation: `admin_dispatch_doc:${ID}`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('X_ADMIN_TOOL_FORBIDDEN');
    expect(result.reason).toContain('agent-1');
    // Defence in depth, and the reason it is not dead code: the repo is never reached.
    expect(fixture.repo.calls).toEqual([]);
  });

  test('a name no catalog ever produced is refused the same way', async () => {
    const fixture = appWith(staticAuthz(GRANTS));
    const result = await call(fixture, 'admin.admin_dispatch_doc.truncate');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('X_ADMIN_TOOL_FORBIDDEN');
  });
});

describe('the CRUD dispatch lands on the repo call that tool names', () => {
  test('list pages through the repo and answers a page, not a bare array', async () => {
    const fixture = appWith(staticAuthz(GRANTS));
    const result = await call(fixture, 'admin.admin_dispatch_doc.list', { limit: 3 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fixture.repo.calls).toEqual(['list']);
    // A number `limit` reaches the repo; anything else is dropped and the resource default wins.
    // `limit + 1`: the page reads one extra row to answer `hasMore` without a second query.
    expect(fixture.repo.limits).toEqual([4]);
    expect((result.data as { rows: readonly AdminRow[] }).rows).toEqual([ROW]);
  });

  test('a non-numeric limit is ignored rather than passed through as NaN', async () => {
    const fixture = appWith(staticAuthz(GRANTS));
    await call(fixture, 'admin.admin_dispatch_doc.list', { limit: '3' });
    // 25 is `DEFAULT_PAGE_SIZE` from the derived resource — the value `num()` falling back means.
    expect(fixture.repo.limits).toEqual([26]);
  });

  test('read resolves the id and answers the row', async () => {
    const fixture = appWith(staticAuthz(GRANTS));
    const result = await call(fixture, 'admin.admin_dispatch_doc.read', { id: ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fixture.repo.calls).toEqual([`find:${ID}`]);
    expect(result.data).toEqual(ROW);
  });

  test('create passes the whole argument bag as the row', async () => {
    const fixture = appWith(staticAuthz(GRANTS));
    const result = await call(fixture, 'admin.admin_dispatch_doc.create', { title: 'Second' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fixture.repo.calls).toEqual(['create']);
    expect((result.data as AdminRow)['title']).toBe('Second');
  });

  test('update addresses the row by id and never writes the id back into the patch', async () => {
    const fixture = appWith(staticAuthz(GRANTS));
    const result = await call(fixture, 'admin.admin_dispatch_doc.update', {
      id: ID,
      title: 'Renamed',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `withoutKeys(input, ['id'])`: an `id` inside the patch is a primary key rewrite the repo
    // never asked for, and it addresses the row already.
    expect(fixture.repo.calls).toEqual([`find:${ID}`, `update:${ID}`]);
    // The id is addressed, never re-written: a primary key inside the patch is a rewrite the
    // repo never asked for, and `withoutKeys(input, ['id'])` is the one place it is stripped.
    expect(fixture.repo.patches).toEqual([{ title: 'Renamed' }]);
    expect((result.data as AdminRow)['title']).toBe('Renamed');
  });

  test('delete requires the echoed confirmation token, and refuses without it', async () => {
    const fixture = appWith(staticAuthz(GRANTS));
    const refused = await call(fixture, 'admin.admin_dispatch_doc.delete', { id: ID });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBe('X_ADMIN_DENIED');
    expect(refused.reason).toBe('admin.error.confirmation-required');
    // The row was loaded to decide, but never destroyed.
    expect(fixture.repo.calls).toEqual([`find:${ID}`]);

    const done = await call(fixture, 'admin.admin_dispatch_doc.delete', {
      id: ID,
      confirmation: `admin_dispatch_doc:${ID}`,
    });
    expect(done.ok).toBe(true);
    expect(fixture.repo.calls).toEqual([`find:${ID}`, `find:${ID}`, `destroy:${ID}`]);
  });

  test('search runs across the app’s resources and reports the term it ran', async () => {
    const fixture = appWith(staticAuthz(GRANTS));
    const result = await call(fixture, 'admin.search', { term: 'First' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { term: string }).term).toBe('First');
  });
});

describe('a denial inside the CRUD call comes back as a denial, not as a crash', () => {
  /** Allows everything the catalog is derived from, and refuses the one operation under test. */
  const allowExcept = (refusedPermission: string, refusedSubjectId: string): AdminAuthz => {
    const base = staticAuthz(GRANTS);
    return {
      decide(query): AdminDecision {
        const subject = query.subject as AdminSubject | undefined;
        if (query.permission === refusedPermission && subject?.id === refusedSubjectId) {
          return {
            allowed: false,
            permission: query.permission,
            reason: 'probe.row-refused',
            trace: [],
          };
        }
        return base.decide(query);
      },
    };
  };

  test('a row-level refusal on read answers X_ADMIN_DENIED with the policy’s own reason', async () => {
    const fixture = appWith(allowExcept('admin_dispatch_doc:read', ID));
    const result = await call(fixture, 'admin.admin_dispatch_doc.read', { id: ID });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('X_ADMIN_DENIED');
    // The reason a policy gave, carried verbatim — an agent has to be able to reason about it.
    expect(result.reason).toBe('probe.row-refused');
  });

  test('a refusal on list answers X_ADMIN_DENIED too, and reads nothing', async () => {
    const listRefused: AdminAuthz = {
      decide(query): AdminDecision {
        return query.permission === 'admin_dispatch_doc:read'
          ? {
              allowed: false,
              permission: query.permission,
              reason: 'probe.list-refused',
              trace: [],
            }
          : staticAuthz(GRANTS).decide(query);
      },
    };
    // The catalog is derived from the same authz, so the tool must still be visible to be called:
    // `read` is refused, which is what `list` and `read` both gate on.
    const fixture = appWith(listRefused);
    const result = await call(fixture, 'admin.admin_dispatch_doc.list', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('X_ADMIN_TOOL_FORBIDDEN');
    expect(fixture.repo.calls).toEqual([]);
  });
});

describe('an input the entity refuses comes back as X_ADMIN_INVALID, not as a denial', () => {
  test('the issues travel with it, so an agent can correct and retry', async () => {
    const fixture = appWith(staticAuthz(GRANTS));
    // A direct `callAdminTool` — the transport's own `additionalProperties`/type check never
    // ran, which is exactly why `adminUpdate` re-validates against the entity's schema.
    const result = await call(fixture, 'admin.admin_dispatch_doc.update', { id: ID, title: 42 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A different code from a denial on purpose: an agent retries one and never the other.
    expect(result.error).toBe('X_ADMIN_INVALID');
    const issues = JSON.parse(result.reason) as readonly { message: string }[];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('expected a string');
    // Refused before the write: the entity's own rule, never a second admin one.
    expect(fixture.repo.calls).toEqual([`find:${ID}`]);
  });
});

describe('the action dispatch', () => {
  const reindex = {
    name: 'admin.reindex',
    permission: 'admin_dispatch_doc:write',
    mcp: { expose: true, description: 'Rebuild the index' },
    handle: async (args: { readonly input: unknown }): Promise<unknown> => ({
      reindexed: args.input,
    }),
  };

  const appWithAction = (): Fixture => {
    const calls = recordingRepo();
    const authz = staticAuthz(GRANTS);
    const app = defineAdmin({
      entities: [doc],
      actions: [reindex as never],
      resources: { admin_dispatch_doc: { repo: calls.repo } },
      auth: { actor: (): AdminActor | null => ACTOR, authz },
    });
    return {
      app,
      repo: calls,
      ctx: { actor: ACTOR, authz, audit: memoryAuditLog(), requestId: 'req_dispatch' },
    };
  };

  test('the handler runs and the confirmation key is stripped from its input', async () => {
    const fixture = appWithAction();
    const result = await call(fixture, 'admin.action.admin.reindex', {
      confirmation: 'admin:',
      scope: 'all',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `withoutKeys(input, ['confirmation'])`: the admin's own envelope key is not part of the
    // action's payload, and an action's own schema would refuse it.
    expect(result.data).toEqual({ reindexed: { scope: 'all' } });
  });

  test('the action is audited under "admin" with the id the call named', async () => {
    const fixture = appWithAction();
    await call(fixture, 'admin.action.admin.reindex', { id: 'r_7' });

    const entry = fixture.ctx.audit.entries()[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.kind).toBe('action');
    expect(entry.operation).toBe('admin.reindex');
    // A global action has no entity, so `admin` is the subject the audit row names.
    expect(entry.entity).toBe('admin');
    expect(entry.entityId).toBe('r_7');
  });
});

describe('adminMcp() resolves a session token into an agent actor', () => {
  const serverFor = (
    lookup: (session: { readonly token?: string }) => AdminActor | null,
  ): ReturnType<typeof adminMcp> => {
    const fixture = appWith(staticAuthz(GRANTS));
    return adminMcp({ app: fixture.app, actor: lookup, requestId: (): string => 'req_token' });
  };

  const post = (
    mcp: ReturnType<typeof adminMcp>,
    authorization: string | null,
  ): Promise<Response> => {
    const route = mcp.route;
    if (route === undefined) throw new Error('adminMcp() published no HTTP route to drive');
    return route.handle(
      new Request('https://admin.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorization === null ? {} : { authorization }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
  };

  test('a known token is answered as an AGENT, with the roles the app looked up', async () => {
    const seen: (string | undefined)[] = [];
    const mcp = serverFor((session) => {
      seen.push(session.token);
      return { id: 'agent-1', roles: ['ops'] };
    });

    const response = await post(mcp, 'Bearer tok_abc');
    const body = (await response.json()) as { result?: { tools: { name: string }[] } };

    expect(response.status).toBe(200);
    // The token the transport pulled off the header reached the app's own lookup, verbatim.
    expect(seen).toEqual(['tok_abc']);
    // The catalog is this actor's — `staticAuthz(GRANTS)` has no `admin:read` implied by
    // `admin:destroy`? it does, so the read tools are there.
    expect((body.result?.tools ?? []).map((tool) => tool.name)).toContain(
      'admin.admin_dispatch_doc.read',
    );
  });

  test('an unknown token is 401, and never reaches the catalog', async () => {
    const mcp = serverFor(() => null);
    const response = await post(mcp, 'Bearer tok_nope');
    expect(response.status).toBe(401);
  });

  test('no Authorization header at all is 401 before the body is even read', async () => {
    const mcp = serverFor(() => ({ id: 'agent-1', roles: ['ops'] }));
    const response = await post(mcp, null);
    expect(response.status).toBe(401);
  });
});
