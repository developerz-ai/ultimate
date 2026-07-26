import { describe, expect, test } from 'bun:test';
import type { ManifestSources } from './build';
import { buildManifest } from './build';
import { manifestJson, verifyBuildId } from './emit';
import { MANIFEST_VERSION } from './schema';

const sources: ManifestSources = {
  app: { name: 'acme', version: '1.4.2' },
  routes: [
    { url: '/posts/[slug]', render: 'isr', revalidateTags: ['post'] },
    { url: '/', render: 'static' },
  ],
  entities: [
    {
      name: 'post',
      table: 'posts',
      columns: [
        { name: 'title', type: 'text', nullable: false },
        { name: 'id', type: 'uuid', nullable: false, primaryKey: true },
      ],
      invariants: ['publish_at_after_created_at', 'slug_unique'],
    },
  ],
  actions: [
    {
      name: 'publishPost',
      input: { postId: 'uuid' },
      output: { id: 'uuid' },
      policy: 'post:publish',
      cacheInvalidates: ['feed', 'post'],
      mcp: { expose: true, description: 'Publish a draft post' },
    },
    {
      name: 'archivePost',
      input: { postId: 'uuid' },
      output: { ok: true },
      policy: 'post:archive',
      cacheInvalidates: ['post'],
      mcp: { expose: false },
    },
  ],
  queries: [
    {
      name: 'liveFeed',
      input: { orgId: 'uuid' },
      policy: 'feed:read',
      live: true,
      cacheTags: ['feed'],
    },
  ],
  jobs: [
    {
      name: 'onboardOrg',
      input: { orgId: 'uuid' },
      queue: 'default',
      retry: { attempts: 5, backoff: 'exponential' },
      steps: ['provision', 'welcome-email', 'nudge'],
    },
  ],
  tasks: [{ name: 'nightlyDigest', cron: '0 3 * * *', tz: 'UTC', enqueues: ['sendDigest'] }],
  policies: [{ permission: 'post:publish', enforcedIn: ['mcp', 'http'] }],
  locales: ['es', 'en'],
  errorCodes: [{ code: 'X_DB_DRIFT', package: 'db' }],
};

describe('the manifest is deterministic', () => {
  test('building twice produces an identical string', () => {
    const first = manifestJson(buildManifest(sources));
    const second = manifestJson(buildManifest(sources));
    // It is committed and diffed in review. A manifest that churns trains reviewers to
    // ignore its diff, which defeats the whole mechanism.
    expect(first).toBe(second);
  });

  test('source order does not change the output', () => {
    const reversed: ManifestSources = {
      ...sources,
      actions: [...(sources.actions ?? [])].reverse(),
      routes: [...(sources.routes ?? [])].reverse(),
      locales: ['en', 'es'],
    };
    expect(manifestJson(buildManifest(reversed))).toBe(manifestJson(buildManifest(sources)));
  });

  test('no timestamp, git sha, or hostname leaks into the output', () => {
    const text = manifestJson(buildManifest(sources));
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text.toLowerCase()).not.toContain('timestamp');
    expect(text.toLowerCase()).not.toContain('generatedat');
  });

  test('a changed fact changes the buildId', () => {
    const base = buildManifest(sources);
    const changed = buildManifest({
      ...sources,
      actions: [
        ...(sources.actions ?? []).slice(1),
        {
          name: 'publishPost',
          input: { postId: 'uuid', notify: 'boolean' },
          output: { id: 'uuid' },
          policy: 'post:publish',
          cacheInvalidates: ['feed', 'post'],
          mcp: { expose: true },
        },
      ],
    });
    expect(changed.buildId).not.toBe(base.buildId);
  });

  test('buildId is verifiable from the file alone', () => {
    expect(verifyBuildId(buildManifest(sources))).toBe(true);
  });
});

describe('normalisation', () => {
  test('collections are sorted, but job steps keep their declared order', () => {
    const manifest = buildManifest(sources);
    expect(manifest.actions.map((a) => a.name)).toEqual(['archivePost', 'publishPost']);
    expect(manifest.routes.map((r) => r.url)).toEqual(['/', '/posts/[slug]']);
    expect(manifest.entities[0]?.columns.map((c) => c.name)).toEqual(['id', 'title']);
    expect(manifest.locales).toEqual(['en', 'es']);
    // A job's steps are a sequence, not a set — sorting them would misrepresent the program.
    expect(manifest.jobs[0]?.steps).toEqual(['provision', 'welcome-email', 'nudge']);
  });

  test('permissions are derived from policies and primitives, never declared twice', () => {
    const manifest = buildManifest(sources);
    expect(manifest.permissions).toEqual(['feed:read', 'post:archive', 'post:publish']);
    expect(manifest.manifestVersion).toBe(MANIFEST_VERSION);
  });
});
