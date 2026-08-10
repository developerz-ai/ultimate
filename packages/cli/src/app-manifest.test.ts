// The CLI's app loader and manifest projection, against a real app written to disk: the point
// of the change these tests guard is that `x manifest` reads the framework's own registries, so
// a fixture that only pretended to be a module would prove nothing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// Bun ships no `Bun.*` equivalent for either: `rm` tears the fixture tree down recursively between
// runs, and `join` builds the host-separator paths the fixture is written to and read from.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resetRegistry as resetActions } from '@ultimat3/action';
import { clearRegistry as clearEntities } from '@ultimat3/entity';
import { resetCatalogs } from '@ultimat3/i18n';
import { resetJobs, resetTasks } from '@ultimat3/jobs';
import { clearPermissions, clearRoles } from '@ultimat3/policy';
import { resetRegistry as resetQueries } from '@ultimat3/query';
import { clearRoutes } from '@ultimat3/render';
import { loadApp, resetAppLoad } from './app-load';
import { appManifest } from './app-manifest';
import type { ThrownShape } from './thrown-by';

// Under `packages/cli/` so the fixture's `@ultimat3/*` imports resolve through the same tsconfig
// paths the framework's own sources use; a dot-prefixed name keeps it out of every workspace glob.
const ROOT = join(import.meta.dir, '..', '.app-fixture');

const FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'fixture-app', version: '2.1.0' }),

  'apps/web/app/posts/policy.ts': `import { can, definePermissions } from '@ultimat3/policy';
export const permissions = definePermissions(['post:read', 'post:publish'] as const);
export const canPostRead = can('post:read');
export const canPostWrite = can('post:publish');
`,

  'apps/web/app/posts/errors.ts': `export const POSTS_ERROR_CODES = ['X_POST_NOT_FOUND'] as const;
`,

  // The two shapes an app actually declares codes in. Neither of the ones below is exported in any
  // \`*_ERROR_CODES\` array — which is how the reference app writes every one of its codes, and why
  // an exports-only scan published \`"errorCodes": []\` for an app that ships seven.
  'apps/web/app/orgs/service.ts': `export const orgMissing = (id: string) => ({
  code: 'X_ORG_NOT_FOUND',
  cause: \`org \${id} does not exist\`,
  fix: 'x db migrate --json',
});
`,

  'packages/domain/src/rules.ts': `export const tenantMissing = () => ({
  code: 'X_DB_TENANT_MISSING',
  cause: 'no tenant is in scope',
  fix: 'x db migrate --json',
});
`,

  'apps/web/app/posts/actions.ts': `import { action, mutator, t } from '@ultimat3/action';
import { canPostWrite } from './policy';

export const publishPost = action({
  input: t.object({ id: t.uuid }),
  output: t.object({ id: t.uuid }),
  policy: canPostWrite,
  mcp: { expose: true, description: 'publish a post' },
  async handle({ input }) {
    return { id: input.id };
  },
});

export const likePost = mutator({
  input: t.object({ id: t.uuid }),
  output: t.object({ id: t.uuid }),
  policy: canPostWrite,
  local() {},
  async server(_ctx, input) {
    return { id: input.id };
  },
  conflict: 'server-wins',
});
`,

  // Under `packages/*/src/**`, which is where `defineCatalogs()` runs in a real app — the
  // manifest's locales have to come from the registry that call populates, not a directory scan.
  'packages/i18n/src/index.ts': `import { defineCatalogs } from '@ultimat3/i18n';

export const catalogs = defineCatalogs({
  default: 'en',
  locales: { en: { posts: { title: 'Posts' } }, fr: { posts: { title: 'Articles' } } },
});
`,

  'apps/web/app/posts/live.ts': `import { from, query, t } from '@ultimat3/query';
import { canPostRead } from './policy';

export const recentPosts = query({
  input: t.object({ limit: t.number.default(10) }),
  policy: canPostRead,
  live: true,
  sql: ({ limit }) =>
    from<{ id: string }>('posts', () => []).orderBy('id').limit(limit),
});
`,

  'apps/web/site/pricing/page.tsx': `import { defineRoute } from '@ultimat3/render';

export const config = defineRoute({
  render: 'static',
  offline: 'precache',
  hydrate: 'never',
  budget: { js: '0kb', lcp: 1200 },
  meta: () => ({ title: 'Pricing' }),
});
`,

  // Imports a module that does not exist: a load failure has to become a finding, never a
  // silently missing primitive.
  'apps/web/app/broken.ts': `export { nope } from './does-not-exist';
`,
};

const resetRegistries = (): void => {
  resetActions();
  resetQueries();
  clearEntities();
  clearRoutes();
  resetJobs();
  resetTasks();
  clearPermissions();
  clearRoles();
  // The catalog registry is process-global like the rest, and `locales` is read straight off it —
  // a locale another suite registered would otherwise turn up in this app's manifest.
  resetCatalogs();
  resetAppLoad();
};

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(FILES)) {
    await Bun.write(join(ROOT, path), contents);
  }
  resetRegistries();
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  resetRegistries();
});

describe('unit · x manifest', () => {
  test('the manifest is the framework registries, not a second scan of the source', async () => {
    const { manifest } = await appManifest(ROOT);

    expect(manifest.app).toEqual({ name: 'fixture-app', version: '2.1.0' });
    expect(manifest.actions.map((action) => action.name)).toEqual(['likePost', 'publishPost']);
    expect(manifest.actions[1]?.policy).toBe('post:publish');
    expect(manifest.actions[1]?.mcp).toEqual({ expose: true, description: 'publish a post' });
    expect(manifest.queries.map((query) => query.name)).toEqual(['recentPosts']);
    expect(manifest.queries[0]?.live).toBe(true);
  });

  // A mutator registers as an action and describes with `kind: 'action'`, so without the flag
  // `x manifest`'s mutator count reads zero for an app that ships one.
  test('a mutator is an action carrying the flag; a plain action has no such key', async () => {
    const { manifest } = await appManifest(ROOT);
    expect(manifest.actions.map((action) => 'mutator' in action)).toEqual([true, false]);
    expect(manifest.actions[0]?.mutator).toBe(true);
  });

  // `defineCatalogs()` ran during `loadApp`, so the locales are the ones the app registered.
  test('the locales are read off the i18n registry the app populated at import', async () => {
    const { manifest } = await appManifest(ROOT);
    expect(manifest.locales).toEqual(['en', 'fr']);
  });

  test('a route is registered through render, so its URL comes from the file path', async () => {
    const { manifest } = await appManifest(ROOT);
    expect(manifest.routes).toEqual([
      {
        url: '/pricing',
        render: 'static',
        offline: 'precache',
        hydrate: 'never',
        revalidateTags: [],
        surface: 'site',
        budget: { js: '0kb', lcp: 1200 },
      },
    ]);
  });

  test('permissions are derived, and each one names the surfaces that enforce it', async () => {
    const { manifest } = await appManifest(ROOT);
    expect(manifest.permissions).toEqual(['post:publish', 'post:read']);
    expect(manifest.policies).toEqual([
      { permission: 'post:publish', enforcedIn: ['action:likePost', 'action:publishPost'] },
      { permission: 'post:read', enforcedIn: ['query:recentPosts'] },
    ]);
  });

  // Every code the app's source declares, through `collectDeclaredCodes` — the one answer to
  // "which codes exist, and where is each declared?". The two throw-site codes are the regression:
  // the exports-only scan this replaced saw `POSTS_ERROR_CODES` and nothing else, so an app that
  // declares its codes where it throws them published a manifest claiming it had none.
  test('error codes are every one the source declares, tagged with its workspace', async () => {
    const { manifest } = await appManifest(ROOT);
    expect(manifest.errorCodes).toEqual([
      { code: 'X_ORG_NOT_FOUND', package: 'apps/web' },
      { code: 'X_POST_NOT_FOUND', package: 'apps/web' },
      { code: 'X_DB_TENANT_MISSING', package: 'packages/domain' },
    ]);
  });

  // `loadApp` sorts by code and the manifest re-sorts by workspace, so the two orders differ on
  // purpose; what may never differ is the set, or a fact's owner.
  test('the loader hands the same codes over, sorted by code', async () => {
    const { errorCodes } = await loadApp(ROOT);
    expect(errorCodes).toEqual([
      { code: 'X_DB_TENANT_MISSING', package: 'packages/domain' },
      { code: 'X_ORG_NOT_FOUND', package: 'apps/web' },
      { code: 'X_POST_NOT_FOUND', package: 'apps/web' },
    ]);
  });

  test('a module that will not import is a finding, not a silently missing primitive', async () => {
    const { findings } = await appManifest(ROOT);
    expect(findings.map((finding) => finding.at)).toEqual(['apps/web/app/broken.ts']);
    expect(findings[0]?.fix.length).toBeGreaterThan(0);
  });

  test('the buildId is content-addressed: two builds of one tree agree', async () => {
    const first = await appManifest(ROOT);
    const second = await appManifest(ROOT);
    expect(second.manifest.buildId).toBe(first.manifest.buildId);
    expect(second.manifest.buildId.length).toBeGreaterThan(0);
  });

  // `x dev` rescans on every save. Registries reject a second registration of a name, so a
  // rescan that re-registered would take the dev server down on the first keystroke.
  test('rescanning does not double-register', async () => {
    await loadApp(ROOT);
    const { manifest, findings } = await appManifest(ROOT);
    expect(manifest.actions).toHaveLength(2);
    expect(manifest.queries).toHaveLength(1);
    expect(findings.map((finding) => finding.code)).toHaveLength(1);
  });
});

/** `thrownBy` is synchronous and `appManifest` is not; the assertion is the same three fields. */
async function rejectedBy(call: () => Promise<unknown>): Promise<ThrownShape> {
  try {
    await call();
  } catch (error) {
    return error as ThrownShape;
  }
  return expect.unreachable('expected a rejection');
}

// The manifest's `app.version` IS the semver compatibility gate, so every way of not knowing the
// app's identity has to fail here — a default would publish a contract the app never claimed.
describe('unit · app identity', () => {
  const IDENTITY_ROOT = join(import.meta.dir, '..', '.identity-fixture');

  const withPackageJson = async (
    contents: string | undefined,
    assert: (shape: ThrownShape) => void,
  ): Promise<void> => {
    await rm(IDENTITY_ROOT, { recursive: true, force: true });
    if (contents === undefined) await Bun.write(join(IDENTITY_ROOT, '.keep'), '');
    else await Bun.write(join(IDENTITY_ROOT, 'package.json'), contents);
    try {
      assert(await rejectedBy(() => appManifest(IDENTITY_ROOT)));
    } finally {
      await rm(IDENTITY_ROOT, { recursive: true, force: true });
    }
  };

  test('a well-formed package.json is the app identity, verbatim', async () => {
    const { manifest } = await appManifest(ROOT);
    expect(manifest.app).toEqual({ name: 'fixture-app', version: '2.1.0' });
  });

  test('a missing package.json fails with the command that creates the fields', async () => {
    await withPackageJson(undefined, (shape) => {
      expect(shape.code).toBe('X_APP_PACKAGE_INVALID');
      expect(shape.cause).toContain('does not exist');
      expect(shape.fix).toBe('bun pm pkg set name=<app> version=0.1.0');
    });
  });

  test('malformed JSON fails instead of defaulting to app@0.0.0', async () => {
    await withPackageJson('{ "name": ', (shape) => {
      expect(shape.code).toBe('X_APP_PACKAGE_INVALID');
      expect(shape.cause).toContain('is not a JSON object');
    });
  });

  test('a missing name fails, naming the field', async () => {
    await withPackageJson(JSON.stringify({ version: '1.0.0' }), (shape) => {
      expect(shape.code).toBe('X_APP_PACKAGE_INVALID');
      expect(shape.cause).toContain('"name"');
    });
  });

  test('a non-string version fails, naming the field', async () => {
    await withPackageJson(JSON.stringify({ name: 'app', version: 2 }), (shape) => {
      expect(shape.code).toBe('X_APP_PACKAGE_INVALID');
      expect(shape.cause).toContain('"version"');
    });
  });
});
