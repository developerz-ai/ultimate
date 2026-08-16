import { describe, expect, test } from 'bun:test';
import type { ManifestSources } from './build';
import { buildManifest } from './build';
import { diffManifest } from './diff';
import type { Manifest } from './schema';
import { verifyContract } from './verify';

// `permissions` is what a rule matches on and `policy` is only the label it renders, so the
// fixture keeps them independent: passing the label as the permission list would let a rule that
// reads the wrong field still pass every assertion below.
const action = (name: string, policy: string, expose = true, permissions = [policy]) => ({
  name,
  input: { id: 'uuid' },
  output: { ok: 'boolean' },
  policy,
  permissions,
  cacheInvalidates: ['post'],
  mcp: { expose },
});

const query = (name: string, policy: string, permissions = [policy]) => ({
  name,
  input: {},
  policy,
  permissions,
  live: true,
  cacheTags: [],
});

const base: ManifestSources = {
  app: { name: 'acme', version: '1.4.2' },
  routes: [{ url: '/posts', render: 'isr' as const }],
  entities: [
    {
      name: 'post',
      table: 'posts',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, primaryKey: true },
        { name: 'note', type: 'text', nullable: true },
      ],
      invariants: [],
    },
  ],
  actions: [action('publishPost', 'post:publish'), action('archivePost', 'post:archive')],
  queries: [query('feed', 'feed:read')],
  jobs: [
    {
      name: 'onboard',
      input: { orgId: 'uuid' },
      queue: 'default',
      retry: { attempts: 3, backoff: 'exponential' },
      steps: ['a'],
    },
  ],
  tasks: [],
  policies: [],
  locales: ['en'],
  errorCodes: [],
};

const withActions = (actions: ManifestSources['actions']) => buildManifest({ ...base, actions });
const withEntities = (entities: ManifestSources['entities']) =>
  buildManifest({ ...base, entities });
const withJobs = (jobs: ManifestSources['jobs']) => buildManifest({ ...base, jobs });
const withQueries = (queries: ManifestSources['queries']) => buildManifest({ ...base, queries });

describe('classification', () => {
  test('a removed action is breaking', () => {
    const before = buildManifest(base);
    const after = withActions([action('archivePost', 'post:archive')]);
    const diff = diffManifest(before, after);
    expect(diff.hasBreaking).toBe(true);
    expect(diff.breaking.map((c) => c.path)).toContain('actions.publishPost');
    expect(diff.breaking.find((c) => c.path === 'actions.publishPost')?.detail).toBe(
      'action removed',
    );
  });

  test('an added action is additive, not breaking', () => {
    const before = buildManifest(base);
    const after = withActions([...(base.actions ?? []), action('draftPost', 'post:draft')]);
    const diff = diffManifest(before, after);
    expect(diff.hasBreaking).toBe(false);
    expect(diff.additive.map((c) => c.path)).toContain('actions.draftPost');
  });

  test('a changed policy or output is breaking; a changed cache tag is internal', () => {
    const before = buildManifest(base);
    const after = withActions([
      { ...action('publishPost', 'post:admin'), cacheInvalidates: ['feed'] },
      action('archivePost', 'post:archive'),
    ]);
    const diff = diffManifest(before, after);
    expect(diff.breaking.map((c) => c.path)).toContain('actions.publishPost.policy');
    expect(diff.internal.map((c) => c.path)).toContain('actions.publishPost.cacheInvalidates');
  });

  test('withdrawing MCP exposure is breaking; granting it is additive', () => {
    const before = buildManifest(base);
    const withdrawn = withActions([
      action('publishPost', 'post:publish', false),
      action('archivePost', 'post:archive'),
    ]);
    expect(diffManifest(before, withdrawn).breaking.map((c) => c.path)).toContain(
      'actions.publishPost.mcp.expose',
    );
    expect(diffManifest(withdrawn, before).additive.map((c) => c.path)).toContain(
      'actions.publishPost.mcp.expose',
    );
  });

  // `before` is a file read off disk, so nothing checked its types first. An older or
  // hand-trimmed manifest whose `expose` is absent must read as "not exposed" — the same answer
  // `isMcpExposed` gives every other surface — rather than as a third state `!==` calls a change.
  test('a manifest that omits mcp.expose reads as un-exposed, not as a change', () => {
    const unexposed = withActions([
      action('publishPost', 'post:publish', false),
      action('archivePost', 'post:archive', false),
    ]);
    const parsed = JSON.parse(JSON.stringify(unexposed)) as Manifest;
    for (const fact of parsed.actions) {
      delete (fact.mcp as { expose?: boolean }).expose;
    }

    expect(diffManifest(parsed, unexposed).changes.map((c) => c.path)).not.toContain(
      'actions.publishPost.mcp.expose',
    );
    // And opting in from that same file is still the additive change it really is.
    expect(diffManifest(parsed, buildManifest(base)).additive.map((c) => c.path)).toContain(
      'actions.publishPost.mcp.expose',
    );
  });

  // The failure this rule exists for: the grant set moved and the LABEL did not, so every other
  // check in the classifier — policy included — sees an unchanged action, while every caller
  // holding yesterday's grants starts collecting 403s.
  test('an action that gains a required permission is breaking', () => {
    const before = buildManifest(base);
    const after = withActions([
      action('publishPost', 'post:publish', true, ['org:administer', 'post:publish']),
      action('archivePost', 'post:archive'),
    ]);
    const diff = diffManifest(before, after);
    expect(diff.hasBreaking).toBe(true);
    expect(diff.breaking.map((c) => c.path)).toEqual([
      'actions.publishPost.permissions.org:administer',
    ]);
  });

  test('a query that gains a required permission is breaking', () => {
    const before = buildManifest(base);
    const after = withQueries([query('feed', 'feed:read', ['feed:read', 'org:member'])]);
    const diff = diffManifest(before, after);
    expect(diff.breaking.map((c) => c.path)).toEqual(['queries.feed.permissions.org:member']);
  });

  // `archivePost` keeps `org:administer` on both sides deliberately: the top-level `permissions`
  // set is the app's vocabulary and losing an entry from it is already classified breaking there,
  // which is a different statement from this one — that dropping a requirement from ONE operation
  // widens access rather than withdrawing it.
  test('an action that loses a required permission is additive, not breaking', () => {
    const administered = action('archivePost', 'post:archive', true, [
      'org:administer',
      'post:archive',
    ]);
    const before = withActions([
      action('publishPost', 'post:publish', true, ['org:administer', 'post:publish']),
      administered,
    ]);
    const after = withActions([action('publishPost', 'post:publish'), administered]);
    const diff = diffManifest(before, after);
    expect(diff.hasBreaking).toBe(false);
    // Reported all the same: a grant dropped from an operation is a widening a reviewer must see.
    expect(diff.additive.map((c) => c.path)).toContain(
      'actions.publishPost.permissions.org:administer',
    );
  });

  // `before` is a file off disk. A manifest written before the field existed carries no
  // `permissions` at all, and reading that as `[]` would call every permission of every action
  // newly required — a wall of false breakings for an upgrade that changed no authorization.
  test('a manifest that omits an operation permissions list reports no permission change', () => {
    const current = buildManifest(base);
    const parsed = JSON.parse(JSON.stringify(current)) as Manifest;
    for (const fact of parsed.actions) delete (fact as { permissions?: unknown }).permissions;
    for (const fact of parsed.queries) delete (fact as { permissions?: unknown }).permissions;

    const gained = withActions([
      action('publishPost', 'post:publish', true, ['org:administer', 'post:publish']),
      action('archivePost', 'post:archive'),
    ]);
    for (const diff of [diffManifest(parsed, current), diffManifest(parsed, gained)]) {
      expect(diff.changes.filter((c) => c.path.includes('.permissions.'))).toEqual([]);
    }
  });

  const limited = (limit: number, windowMs: number) => [
    { ...action('publishPost', 'post:publish'), rateLimit: { limit, windowMs } },
    action('archivePost', 'post:archive'),
  ];

  test('a tightened rate limit is breaking', () => {
    const before = withActions(limited(1000, 60_000));
    const after = withActions(limited(5, 60_000));
    const diff = diffManifest(before, after);
    expect(diff.hasBreaking).toBe(true);
    expect(diff.breaking.map((c) => c.path)).toEqual(['actions.publishPost.rateLimit']);
  });

  test('a loosened rate limit is additive; an unchanged one is no change at all', () => {
    const before = withActions(limited(5, 60_000));
    expect(diffManifest(before, withActions(limited(50, 60_000))).hasBreaking).toBe(false);
    expect(
      diffManifest(before, withActions(limited(50, 60_000))).additive.map((c) => c.path),
    ).toContain('actions.publishPost.rateLimit');
    expect(
      diffManifest(before, withActions(limited(5, 60_000))).changes.map((c) => c.path),
    ).not.toContain('actions.publishPost.rateLimit');
  });

  // Either half alone refuses somebody: this pair refills fifteen times faster and still hands a
  // client that spent 1000 at once a 429 on its 101st request.
  test('a smaller burst is breaking even when the sustained rate rises', () => {
    const diff = diffManifest(withActions(limited(1000, 60_000)), withActions(limited(100, 1_000)));
    expect(diff.breaking.map((c) => c.path)).toEqual(['actions.publishPost.rateLimit']);
  });

  test('introducing a rate limit is breaking; removing one is additive', () => {
    const none = buildManifest(base);
    const some = withActions(limited(5, 60_000));
    expect(diffManifest(none, some).breaking.map((c) => c.path)).toEqual([
      'actions.publishPost.rateLimit',
    ]);
    const removed = diffManifest(some, none);
    expect(removed.hasBreaking).toBe(false);
    expect(removed.additive.map((c) => c.path)).toContain('actions.publishPost.rateLimit');
  });

  // A window of zero is an infinite refill and a sub-token limit closes the endpoint — neither
  // describes a limit, so there is nothing to compare and the rule stands down rather than
  // convicting the build on a value `toBucket` would have refused at mount.
  test('a rate limit this reader cannot make sense of is not classified', () => {
    const nonsense = JSON.parse(JSON.stringify(withActions(limited(1000, 60_000)))) as Manifest;
    (nonsense.actions[1] as { rateLimit?: unknown }).rateLimit = { limit: 1000, windowMs: 0 };
    const diff = diffManifest(nonsense, withActions(limited(5, 60_000)));
    expect(diff.changes.map((c) => c.path)).not.toContain('actions.publishPost.rateLimit');
  });

  test('a nullable column added is additive; a NOT NULL column added is breaking', () => {
    const before = buildManifest(base);
    const columns = base.entities?.[0]?.columns ?? [];
    const additive = withEntities([
      {
        name: 'post',
        table: 'posts',
        invariants: [],
        columns: [...columns, { name: 'summary', type: 'text', nullable: true }],
      },
    ]);
    const breaking = withEntities([
      {
        name: 'post',
        table: 'posts',
        invariants: [],
        columns: [...columns, { name: 'summary', type: 'text', nullable: false }],
      },
    ]);
    expect(diffManifest(before, additive).hasBreaking).toBe(false);
    expect(diffManifest(before, breaking).hasBreaking).toBe(true);
  });

  test('a job input change is breaking because in-flight payloads stop parsing', () => {
    const before = buildManifest(base);
    const after = withJobs([
      {
        name: 'onboard',
        input: { orgId: 'uuid', plan: 'string' },
        queue: 'default',
        retry: { attempts: 3, backoff: 'exponential' },
        steps: ['a'],
      },
    ]);
    expect(diffManifest(before, after).breaking.map((c) => c.path)).toContain('jobs.onboard.input');
  });

  test('the buildId difference alone is internal', () => {
    const before = buildManifest(base);
    const after = buildManifest({ ...base, locales: ['en', 'fr'] });
    const diff = diffManifest(before, after);
    expect(diff.hasBreaking).toBe(false);
    expect(diff.internal.map((c) => c.path)).toContain('buildId');
  });
});

describe('the version gate', () => {
  test('a breaking change without a major bump throws X_MANIFEST_BREAKING', () => {
    const before = buildManifest(base);
    const after = buildManifest({
      ...base,
      app: { name: 'acme', version: '1.5.0' },
      actions: [action('archivePost', 'post:archive')],
    });
    let thrown: { code?: unknown; cause?: unknown } | undefined;
    try {
      verifyContract({ before, after });
    } catch (error) {
      thrown = error as { code?: unknown; cause?: unknown };
    }
    expect(thrown?.code).toBe('X_MANIFEST_BREAKING');
    expect(String(thrown?.cause)).toContain('actions.publishPost');
  });

  test('the same change passes with a major bump', () => {
    const before = buildManifest(base);
    const after = buildManifest({
      ...base,
      app: { name: 'acme', version: '2.0.0' },
      actions: [action('archivePost', 'post:archive')],
    });
    const result = verifyContract({ before, after });
    expect(result.ok).toBe(true);
    expect(result.majorBumped).toBe(true);
    expect(result.diff.hasBreaking).toBe(true);
  });

  test('an unparseable version never waves a breaking change through', () => {
    const before = buildManifest(base);
    const after = buildManifest({
      ...base,
      app: { name: 'acme', version: 'nightly' },
      actions: [action('archivePost', 'post:archive')],
    });
    expect(() => verifyContract({ before, after })).toThrow();
  });
});
