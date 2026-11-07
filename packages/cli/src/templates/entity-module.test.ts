// Which paths are entity modules: one rule for the generators, the handle registrar and the
// package-boundary exemption, at any slice depth.

import { describe, expect, test } from 'bun:test';
import { entityModuleIn, isEntityModule } from './entity-module';

describe('unit · an entity module, at any slice depth', () => {
  test('a feature slice and a nested one both declare entities', () => {
    expect(isEntityModule('apps/web/app/post/entity.ts')).toBe(true);
    expect(isEntityModule('apps/web/app/post/entity-line.ts')).toBe(true);
    expect(isEntityModule('apps/web/app/runs/canary/entity.ts')).toBe(true);
    expect(isEntityModule('apps/web/app/runs/canary/entity-probe.ts')).toBe(true);
  });

  test('a surface root, a test, a repo and a file outside apps/ do not', () => {
    expect(isEntityModule('apps/web/app/entity.ts')).toBe(false);
    expect(isEntityModule('apps/web/app/post/entity.test.ts')).toBe(false);
    expect(isEntityModule('apps/web/app/runs/canary/repo.ts')).toBe(false);
    expect(isEntityModule('packages/db/src/post/entity.ts')).toBe(false);
  });

  test('the module path a nested entity is imported under keeps every slice segment', () => {
    expect(entityModuleIn('apps/web/app/runs/canary/entity.ts', 'apps/web')).toBe(
      'app/runs/canary/entity',
    );
    expect(entityModuleIn('apps/web/app/post/entity-line.ts', 'apps/web')).toBe(
      'app/post/entity-line',
    );
    expect(entityModuleIn('apps/admin/app/post/entity.ts', 'apps/web')).toBeUndefined();
  });
});
