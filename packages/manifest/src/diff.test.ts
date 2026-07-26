import { describe, expect, test } from 'bun:test';
import type { ManifestSources } from './build';
import { buildManifest } from './build';
import { diffManifest } from './diff';
import { verifyContract } from './verify';

const action = (name: string, policy: string, expose = true) => ({
  name,
  input: { id: 'uuid' },
  output: { ok: 'boolean' },
  policy,
  cacheInvalidates: ['post'],
  mcp: { expose },
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
  queries: [{ name: 'feed', input: {}, policy: 'feed:read', live: true, cacheTags: [] }],
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
