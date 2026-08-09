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

  'apps/web/app/posts/actions.ts': `import { action, t } from '@ultimat3/action';
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

  'apps/web/site/pricing.tsx': `import { defineRoute } from '@ultimat3/render';

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
    expect(manifest.actions.map((action) => action.name)).toEqual(['publishPost']);
    expect(manifest.actions[0]?.policy).toBe('post:publish');
    expect(manifest.actions[0]?.mcp).toEqual({ expose: true, description: 'publish a post' });
    expect(manifest.queries.map((query) => query.name)).toEqual(['recentPosts']);
    expect(manifest.queries[0]?.live).toBe(true);
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
      { permission: 'post:publish', enforcedIn: ['action:publishPost'] },
      { permission: 'post:read', enforcedIn: ['query:recentPosts'] },
    ]);
  });

  test('error codes are flattened out of the app, tagged with the workspace that owns them', async () => {
    const { manifest } = await appManifest(ROOT);
    expect(manifest.errorCodes).toEqual([{ code: 'X_POST_NOT_FOUND', package: 'apps/web' }]);
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
    expect(manifest.actions).toHaveLength(1);
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
