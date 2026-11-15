// The hopped app against HEAD's own scaffold: a file the release added, changed or dropped is
// named, and nothing a first run generates (lockfile, migrations, manifest, dumps) is ever listed.

import { describe, expect, test } from 'bun:test';
import { driftOf } from './upgrade-fixtures-drift';

const tree = (files: Record<string, string>): ReadonlyMap<string, string> =>
  new Map(Object.entries(files));

describe('driftOf', () => {
  test('missing, differing and extra files, each sorted', () => {
    const head = tree({
      'package.json': '{"v":2}',
      'guards/shipped.json': '{}',
      'apps/web/app/auth/authenticator.ts': 'new',
      'README.md': 'same',
    });
    const app = tree({
      'package.json': '{"v":2}',
      'apps/web/app/auth/authenticator.ts': 'old',
      'README.md': 'same',
      'guards/bare-error.ts': 'vendored',
    });
    expect(driftOf(head, app)).toEqual({
      missing: ['guards/shipped.json'],
      differs: ['apps/web/app/auth/authenticator.ts'],
      extra: ['guards/bare-error.ts'],
    });
  });

  test('what a first run generates is never drift', () => {
    const app = tree({
      'bun.lock': 'x',
      'x.manifest.json': 'x',
      'openapi.json': 'x',
      'packages/db/migrations/0001_initial.sql': 'x',
      'packages/db/schema/framework/04_tables/x_jobs.sql': 'x',
      '.env.development.local': 'x',
      'apps/web/node_modules/@fxapp/db/index.ts': 'x',
      '.x/cache/a': 'x',
      '.npmrc': 'x',
      'tsconfig.tsbuildinfo': 'x',
    });
    expect(driftOf(tree({}), app)).toEqual({ missing: [], differs: [], extra: [] });
    expect(driftOf(tree({ 'x.manifest.json': 'y' }), tree({}))).toEqual({
      missing: [],
      differs: [],
      extra: [],
    });
  });
});
