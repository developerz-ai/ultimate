import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { action, registerActions, resetRegistry as resetActionRegistry, t } from '@ultimat3/action';
import {
  can,
  clearPermissions,
  definePermissions,
  knownPermissions,
  type Permission,
} from '@ultimat3/policy';
import { from, query, registerQuery, resetRegistry as resetQueryRegistry } from '@ultimat3/query';
import { type AdminActor, staticAuthz } from '../authz';
import { defaultDevSources, staticDevSources } from './data';
import type { CacheEdgeFact, MailFact, StatementLoopFact } from './facts';
import { cachePanel } from './panel-cache';

// Both registries are process-global (`@ultimat3/action`, `@ultimat3/query`): this file is the
// only admin test that registers actions or queries, but leaving them seated would still make a
// neighbouring suite flaky the next time someone adds one.
afterEach(() => {
  resetActionRegistry();
  resetQueryRegistry();
});

/** The `can()` capabilities this file's fixture actions and queries declare. */
const WIDGET_PERMISSIONS = ['widget:create', 'widget:delete', 'widget:read'] as const;

let ambientPermissions: readonly string[] = [];

// The permission registry is process-global too, and an EMPTY one means "every permission is
// provisionally known" (`isKnownPermission`) — which is the only reason the `can('widget:*')`
// calls below ever worked. `@ultimat3/admin`'s policy bridge registers its four `admin:*` names
// at module scope, so any process that also loaded that barrel (`bun test` seats several files
// in one) has already left permissive mode and every `can()` here throws X_PERMISSION_UNKNOWN.
// Declaring the set this file uses removes the dependency on which files it is sharded with;
// restoring the ambient set removes the mirror-image hazard for whatever runs next.
beforeAll(() => {
  ambientPermissions = knownPermissions();
  definePermissions(WIDGET_PERMISSIONS);
});

afterAll(() => {
  clearPermissions();
  // Every member arrived through a `definePermissions` call, so it is a `resource:verb` already.
  if (ambientPermissions.length > 0) definePermissions(ambientPermissions as readonly Permission[]);
});

describe('this file owns its permission set', () => {
  test('a neighbouring module declaring its own set cannot make these permissions unknown', () => {
    // Exactly what importing `@ultimat3/admin` does at module scope: it declares a set this file
    // never asked for, and the registry stops answering "known" to everything.
    definePermissions(['neighbour:read']);
    expect(knownPermissions()).toContain('neighbour:read');

    // Delete the `beforeAll` above and this line throws X_PERMISSION_UNKNOWN — the exact failure
    // `bun test <this file> packages/cli/src/error-catalog.test.ts` produced before the fix.
    expect(() => can('widget:read')).not.toThrow();
  });
});

describe('unwired sources reject instead of throwing', () => {
  test('an unwired source rejects rather than throwing synchronously', async () => {
    const sources = defaultDevSources();
    // Mirrors panel-cache.ts's `sources.invalidations().catch(...)`: if `unwired` regresses to a
    // bare `throw`, the call below throws synchronously — before `.catch` ever attaches — and
    // this test fails with an uncaught exception instead of a clean assertion.
    const caught = await sources.traces().catch((error: unknown) => error);
    expect(caught).toBeUltimateError('X_NOT_IMPLEMENTED');
  });

  test('the rejection names the missing source and the panel, with a runnable fix', async () => {
    const sources = defaultDevSources();
    const caught = (await sources.mail().catch((error: unknown) => error)) as {
      cause: string;
      fix: string;
    };
    expect(caught.cause).toContain('mail');
    expect(caught.fix).toContain('defaultDevSources');
    expect(caught.fix).toContain('mail');
    // The default phrasing is still real code an agent can paste and run.
    expect(() => new Function(caught.fix)).not.toThrow();
  });

  // `[]` here would read as "the detector ran and this request was clean" — a verdict this
  // process never earned, since only `x dev` installs the statement ledger that counts one.
  test('statementLoops refuses when no detector is installed, rather than answering []', async () => {
    const caught = (await defaultDevSources()
      .statementLoops()
      .catch((error: unknown) => error)) as { cause: string; fix: string };

    expect(caught).toBeUltimateError('X_NOT_IMPLEMENTED');
    expect(caught.cause).toContain('statementLoops');
    expect(caught.fix).toContain('statementLoops');
    expect(() => new Function(caught.fix)).not.toThrow();
  });
});

describe('cachePanel degrades when its invalidation log is unwired', () => {
  test('the graph still renders and the note explains the missing log', async () => {
    const graph: readonly CacheEdgeFact[] = [{ tag: 'post', dependents: [] }];
    const sources = defaultDevSources({ hooks: { cacheGraph: async () => graph } });

    const data = await cachePanel.data(sources, new URLSearchParams());

    expect(data.graph).toEqual(graph);
    expect(data.invalidations).toEqual([]);
    expect(data.note).toBe('dev.cache.no-invalidations-yet');
  });
});

describe('policyMatrix', () => {
  test("reads the action registry's capability field, not the non-existent policy field", async () => {
    const createWidget = action({
      input: t.object({}),
      output: t.object({}),
      policy: can('widget:create'),
      handle: () => ({}),
    });
    const deleteWidget = action({
      input: t.object({}),
      output: t.object({}),
      policy: can('widget:delete'),
      handle: () => ({}),
    });
    registerActions({ createWidget, deleteWidget });

    const authz = staticAuthz(['widget:create']);
    const actors: readonly AdminActor[] = [{ id: 'a1' }, { id: 'a2' }];
    const sources = defaultDevSources({ authz, actors });

    const matrix = await sources.policyMatrix();

    // If `policyMatrix` reads `raw['policy']` again, every permission comes back '' and is
    // filtered out — `permissions` is empty and the matrix collapses to `[]`, well short of 4.
    expect(matrix).toHaveLength(4);
    expect([...new Set(matrix.map((row) => row.permission))].sort()).toEqual([
      'widget:create',
      'widget:delete',
    ]);
    // The decision must be the real authz's, not a hardcoded value — recompute it directly and
    // compare, for every row.
    for (const row of matrix) {
      const decision = authz.decide({ permission: row.permission, actor: { id: row.actorId } });
      expect(row.allowed).toBe(decision.allowed);
    }
  });

  test('rejects instead of answering an empty matrix when authz or actors are missing', async () => {
    await expect(defaultDevSources().policyMatrix()).rejects.toBeUltimateError('X_NOT_IMPLEMENTED');
    await expect(
      defaultDevSources({ actors: [{ id: 'a1' }] }).policyMatrix(),
    ).rejects.toBeUltimateError('X_NOT_IMPLEMENTED');
    await expect(
      defaultDevSources({ authz: staticAuthz([]) }).policyMatrix(),
    ).rejects.toBeUltimateError('X_NOT_IMPLEMENTED');
  });

  test('the refusal renders a real defaultDevSources call, not "hooks: { authz + actors }"', async () => {
    const caught = (await defaultDevSources()
      .policyMatrix()
      .catch((error: unknown) => error)) as { fix: string };
    expect(caught.fix).not.toContain('+');
    expect(caught.fix).toContain('authz');
    expect(caught.fix).toContain('actors');
    // `hooks: { authz + actors }` is not valid syntax; `new Function` proves the rendered line
    // actually parses, not just that it contains the right words.
    expect(() => new Function(caught.fix)).not.toThrow();
  });
});

describe('liveQueries', () => {
  test("reports each query's capability as its policy field", async () => {
    const widgetFeed = query({
      input: t.object({}),
      policy: can('widget:read'),
      live: true,
      sql: () => from<{ id: string }>('widgets', []),
    });
    registerQuery('widgetFeed', widgetFeed);

    const queries = await defaultDevSources().liveQueries();

    expect(queries).toHaveLength(1);
    expect(queries[0]?.policy).toBe('widget:read');
    expect(queries[0]?.live).toBe(true);
  });
});

describe('hooks', () => {
  test('a hook overrides its matching default source', async () => {
    const custom: readonly MailFact[] = [
      {
        id: 'm1',
        to: 'a@example.com',
        subject: 'hi',
        locale: 'en',
        html: '<p>hi</p>',
        text: 'hi',
        sentAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const sources = defaultDevSources({ hooks: { mail: async () => custom } });

    expect(await sources.mail()).toEqual(custom);
  });
});

describe('the backfill ledger source', () => {
  test('the WHOLE ledger comes back, completed passes included', async () => {
    const { createMemoryDriver, resetJobDriver, setJobDriver } = await import('@ultimat3/jobs');
    const driver = createMemoryDriver();
    setJobDriver(driver);
    try {
      const ledger = driver.backfills;
      // An assertion rather than a throw: `backfills` is optional on `JobDriver`, so this is a
      // claim about the memory driver worth failing on by name — and it narrows the type.
      expect(ledger).toBeDefined();
      if (ledger === undefined) return;
      await ledger.start({ runId: 'r1', name: 'sweep', checksum: 'aa', appVersion: '1.2.0' });
      await ledger.progress('r1', { rows: 40, cursor: 'p40' });
      await ledger.finish('r1', { status: 'completed', rows: 40 });
      await ledger.start({ runId: 'r2', name: 'recount', checksum: 'bb', appVersion: '1.2.0' });
      await ledger.progress('r2', { rows: 7, cursor: 'p7' });

      const facts = await defaultDevSources().backfills();

      // Filtered to `running`, this panel would report a finished sweep as one that never
      // happened — which is the question `x jobs ls` deliberately does NOT answer and this one
      // does. `completed` clears the cursor; the row count is what survives.
      expect(facts.map((fact) => [fact.runId, fact.status, fact.rows])).toEqual([
        ['r2', 'running', 7],
        ['r1', 'completed', 40],
      ]);
      expect(facts[1]?.durationMs).not.toBeNull();
      expect(facts[0]?.durationMs).toBeNull();
      expect(facts[0]?.cursor).toBe('p7');
    } finally {
      resetJobDriver();
      await driver.close();
    }
  });

  test('no queue at all refuses, naming the source and the panel', async () => {
    // The same line `queues` and `jobRuns` draw: a process with no driver cannot answer "what has
    // been swept", and `[]` there would claim nothing ever has. A driver that merely ships no
    // ledger is the other case — `inspectBackfills` answers `[]` for it, in `@ultimat3/jobs`.
    const caught = (await defaultDevSources()
      .backfills()
      .catch((error: unknown) => error)) as { cause: string; fix: string };

    expect(caught).toBeUltimateError('X_NOT_IMPLEMENTED');
    expect(caught.cause).toContain('backfills');
    expect(caught.cause).toContain('jobs');
  });
});

describe('staticDevSources', () => {
  test('still answers empty for everything — the explicit-fixture path must not throw', async () => {
    const sources = staticDevSources();

    await expect(sources.routes()).resolves.toEqual([]);
    await expect(sources.traces()).resolves.toEqual([]);
    await expect(sources.statementLoops()).resolves.toEqual([]);
    await expect(sources.liveQueries()).resolves.toEqual([]);
    await expect(sources.subscribers()).resolves.toEqual([]);
    await expect(sources.jobDefs()).resolves.toEqual([]);
    await expect(sources.queues()).resolves.toEqual([]);
    await expect(sources.jobRuns()).resolves.toEqual([]);
    await expect(sources.backfills()).resolves.toEqual([]);
    await expect(sources.tasks()).resolves.toEqual([]);
    await expect(sources.tables()).resolves.toEqual([]);
    await expect(sources.drift()).resolves.toEqual([]);
    await expect(sources.mail()).resolves.toEqual([]);
    await expect(sources.cacheGraph()).resolves.toEqual([]);
    await expect(sources.invalidations()).resolves.toEqual([]);
    await expect(sources.policyMatrix()).resolves.toEqual([]);
    await expect(sources.runSql('select 1')).resolves.toEqual({
      columns: [],
      rows: [],
      elapsedMs: 0,
    });
    await expect(sources.manifest()).resolves.toEqual({ emitted: null, committed: null, diff: [] });
  });

  test('an injected fixture is the answer — the explicit path is the only detector here', async () => {
    const loops: readonly StatementLoopFact[] = [
      {
        requestId: 'req_1',
        code: 'X_N_PLUS_ONE_QUERY',
        cause: '50 identical statements on members via findById',
        fix: "posts.preload('author')",
        docs: 'https://example.test/n-plus-one',
        subject: 'members.findById',
        count: 50,
        sample: 'select * from members where id = $1',
      },
    ];

    expect(await staticDevSources({ statementLoops: async () => loops }).statementLoops()).toEqual(
      loops,
    );
  });
});
