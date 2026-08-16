import { describe, expect, test } from 'bun:test';
import type { ManifestSources } from './build';
import { buildManifest } from './build';
import { manifestJson, verifyBuildId } from './emit';
import type { Manifest } from './schema';
import { isCompatible, isManifest, MANIFEST_VERSION } from './schema';

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
      permissions: ['post:publish'],
      cacheInvalidates: ['feed', 'post'],
      rateLimit: { limit: 1000, windowMs: 60_000 },
      mcp: { expose: true, description: 'Publish a draft post' },
    },
    {
      name: 'archivePost',
      input: { postId: 'uuid' },
      output: { ok: true },
      // A COMPOSITE, deliberately: the label is not a permission and matches no grant. Deriving
      // the permission list from it published `and(...)` as if it were one and dropped both real
      // grants — and every non-trivial rule in a real app is a composite, so no fixture with a
      // bare `can()` could have caught it.
      policy: 'and(post:archive, org:administer)',
      permissions: ['org:administer', 'post:archive'],
      cacheInvalidates: ['post'],
      mcp: { expose: false },
      mutator: true,
    },
  ],
  queries: [
    {
      name: 'liveFeed',
      input: { orgId: 'uuid' },
      policy: 'feed:read',
      permissions: ['feed:read'],
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
          permissions: ['post:publish'],
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

  // `normalizeAction` rebuilds every fact, so an optional field it forgets to carry disappears
  // from the file with nothing to notice — and `x manifest`'s mutator count reads zero again.
  test('the mutator flag survives normalisation, and is absent on a plain action', () => {
    const actions = buildManifest(sources).actions;
    // Sorted, so: archivePost carries the flag, publishPost does not carry the key at all.
    expect(actions.map((action) => 'mutator' in action)).toEqual([true, false]);
    expect(actions[0]?.mutator).toBe(true);
  });

  // Same failure mode as the mutator flag, and the same reason it needs its own assertion: the
  // rule that classifies a tightened limit as breaking can only see what normalisation carried.
  test('the rate limit survives normalisation, and is absent when none was declared', () => {
    const actions = buildManifest(sources).actions;
    // Sorted, so: archivePost declares none, publishPost declares 1000/minute.
    expect(actions.map((action) => 'rateLimit' in action)).toEqual([false, true]);
    expect(actions[1]?.rateLimit).toEqual({ limit: 1000, windowMs: 60_000 });
  });

  test("an action's own permissions are sorted, whoever assembled the sources", () => {
    const unsorted = buildManifest({
      ...sources,
      actions: [
        {
          ...(sources.actions?.[1] as NonNullable<ManifestSources['actions']>[number]),
          permissions: ['post:archive', 'org:administer'],
        },
      ],
    });
    expect(unsorted.actions[0]?.permissions).toEqual(['org:administer', 'post:archive']);
  });

  test('permissions are derived from policies and primitives, never declared twice', () => {
    const manifest = buildManifest(sources);
    // `org:administer` is here only because `archivePost`'s COMPOSITE policy is flattened. Read
    // from the label instead and this list gains the string `and(post:archive, org:administer)`
    // and loses both of its parts.
    expect(manifest.permissions).toEqual([
      'feed:read',
      'org:administer',
      'post:archive',
      'post:publish',
    ]);
    expect(manifest.manifestVersion).toBe(MANIFEST_VERSION);
  });
});

describe('shape compatibility', () => {
  // The decision an added field turns on. `isCompatible` is an equality check, so bumping
  // `MANIFEST_VERSION` rejects every `x.manifest.json` in existence at once — and `diffManifest`
  // calls a version change breaking, so the bump would also demand a major release of every app
  // that regenerates. A field a reader tolerates by absence is not that, and this is the
  // assertion that stops the reflex: if it ever fails, the bump was earned.
  test('a manifest written before the newest fields is still readable', () => {
    const older = JSON.parse(JSON.stringify(buildManifest(sources))) as Manifest;
    for (const fact of older.actions) {
      delete (fact as { permissions?: unknown }).permissions;
      delete (fact as { rateLimit?: unknown }).rateLimit;
    }
    for (const fact of older.queries) delete (fact as { permissions?: unknown }).permissions;

    expect(isManifest(older)).toBe(true);
    expect(isCompatible(older)).toBe(true);
  });
});
