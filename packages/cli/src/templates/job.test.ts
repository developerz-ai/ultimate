// `x g job`/`x g task` read one fact from the app's disk before assuming the tenant-scoped shape:
// whether the feature's OWN `entity.ts` declares a real tenant column and its `repo.ts` actually
// exports `byId`/`listByOrg`. Measured in dz-showcase's `links` feature — no `orgId`, no `byId` or
// `listByOrg` in `repo.ts` — where `x g task purgeOrphans --feature links` produced a job that
// called `repo.byId`/`repo.listByOrg` and did not compile.

import { describe, expect, test } from 'bun:test';
// why: Bun has no API for a temporary directory or a symlink, and loading a generated file for
// real needs both — a sandbox on disk that borrows the workspace's installed packages.
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os'; // why: same — no Bun native answers the platform temp root.
import { join } from 'node:path'; // why: same — the sandbox's paths are joined, never concatenated.
import { sandboxPath, workspaceRoot } from '../scaffold-typecheck';
import { isTenantScopedSlice, jobFiles, taskFiles } from './job';

const target = { surfaceDir: 'apps/web/app', feature: 'links' } as const;

/** dz-showcase's `links/entity.ts`, reduced to the shape that matters: no `tenant:` at all. */
const LINKS_ENTITY = `import { entity, text, uuid } from '@ultimat3/entity';

export const link = entity('links', {
  columns: { id: uuid().primaryKey(), url: text({ max: 2000 }) },
});

export type Link = typeof link.$row;
`;

/** The paired `repo.ts`: a single-tenant slice's shape, per `entity.ts`'s own comment — `list`
 * instead of `listByOrg`, no `byId` either, because nothing in this feature reads by id yet. */
const LINKS_REPO = `import { db, sql } from '@ultimat3/db';
import type { Link } from './entity';

export async function list(limit = 50): Promise<readonly Link[]> {
  return db().query<Link>(sql\`select * from links order by url limit \${limit}\`);
}
`;

const sourceOf = (
  files: readonly { path: string; contents: unknown }[],
  suffix: string,
): string => {
  const file = files.find((each) => each.path.endsWith(suffix));
  if (file === undefined || typeof file.contents !== 'string')
    return expect.unreachable(`no ${suffix} was emitted`);
  return file.contents;
};

describe('unit · isTenantScopedSlice reads what the feature actually has', () => {
  test('no entity yet: the fresh scaffold is about to be tenant-scoped, so this counts as scoped', () => {
    expect(isTenantScopedSlice(undefined, undefined)).toBe(true);
  });

  test('an entity with no tenant column at all is not scoped', () => {
    expect(isTenantScopedSlice(LINKS_ENTITY, LINKS_REPO)).toBe(false);
  });

  test("an entity declaring tenant: 'none' is not scoped", () => {
    const entity = LINKS_ENTITY.replace(
      'columns: { id: uuid().primaryKey(), url: text({ max: 2000 }) },',
      "tenant: 'none',\n  columns: { id: uuid().primaryKey(), url: text({ max: 2000 }) },",
    );
    expect(isTenantScopedSlice(entity, LINKS_REPO)).toBe(false);
  });

  test('a tenant-scoped entity whose repo never got listByOrg/byId is not scoped either', () => {
    const entity = LINKS_ENTITY.replace('columns: {', "tenant: 'orgId',\n  columns: {");
    expect(isTenantScopedSlice(entity, LINKS_REPO)).toBe(false);
  });

  test('a tenant-scoped entity with the real repo pair is scoped', () => {
    const entity = `tenant: 'orgId'\n${LINKS_ENTITY}`;
    const repo = `export async function byId(id: string) {}\nexport async function listByOrg(orgId: string, limit = 50) {}\n`;
    expect(isTenantScopedSlice(entity, repo)).toBe(true);
  });

  test('a comment mentioning tenant does not count — only a real declaration does', () => {
    const entity = `// tenant: 'orgId' is what a scoped entity would say\n${LINKS_ENTITY}`;
    expect(isTenantScopedSlice(entity, LINKS_REPO)).toBe(false);
  });
});

describe('unit · x g job emits the tenant-scoped shape only where the slice earns it', () => {
  test('a fresh feature gets the tenant-scoped job, byte-identical to before this fix', () => {
    const files = jobFiles('sweep-invoices', { surfaceDir: 'apps/web/app', feature: 'invoice' });
    const source = sourceOf(files, 'jobs/sweep-invoices.ts');
    expect(source).toContain('input: t.object({ id: t.uuid, orgId: t.uuid })');
    expect(source).toContain('tenant: (input) => input.orgId');
    expect(source).toContain('repo.byId(input.id)');
    expect(source).toContain('repo.listByOrg(row.orgId, 1)');
  });

  test('a feature with no tenant column gets the neutral job — no repo, no orgId', () => {
    const files = jobFiles('purge-orphans', {
      ...target,
      sliceEntity: LINKS_ENTITY,
      sliceRepo: LINKS_REPO,
    });
    const source = sourceOf(files, 'jobs/purge-orphans.ts');
    expect(source).not.toContain("'../repo'");
    expect(source).not.toContain("'../entity'");
    // A comment names the tenant-scoped shape's own field, by way of explanation — only the
    // executable lines matter here.
    expect(source).not.toContain('input.orgId');
    expect(source).not.toContain('row.orgId');
    expect(source).toContain("tenant: 'none'");
    expect(source).toContain('input: t.object({ id: t.uuid })');
    // No entity.ts/repo.ts foundation forced onto a slice this job cannot read through anyway.
    expect(files.some((file) => file.path.endsWith('links/entity.ts'))).toBe(false);
    expect(files.some((file) => file.path.endsWith('links/repo.ts'))).toBe(false);
  });

  test('the neutral job test declares no orgId and reads tenantFor as undefined', () => {
    const files = jobFiles('purge-orphans', {
      ...target,
      sliceEntity: LINKS_ENTITY,
      sliceRepo: LINKS_REPO,
    });
    const test = sourceOf(files, 'jobs/purge-orphans.job.test.ts');
    expect(test).not.toContain('orgId');
    expect(test).toContain('toBeUndefined()');
  });
});

describe('unit · x g task composes the same decision as x g job', () => {
  test('a neutral task enqueues its job with no orgId in the payload', () => {
    const files = taskFiles('purge-orphans', {
      ...target,
      sliceEntity: LINKS_ENTITY,
      sliceRepo: LINKS_REPO,
    });
    const source = sourceOf(files, 'tasks/purge-orphans.ts');
    expect(source).not.toContain('orgId');
    expect(source).toContain("{ id: '00000000-0000-4000-8000-000000000001' }");
    const job = sourceOf(files, 'jobs/purge-orphans-job.ts');
    expect(job).toContain("tenant: 'none'");
  });

  test('a tenant-scoped task keeps the orgId payload, byte-identical to before this fix', () => {
    const files = taskFiles('nightly-sweep', { surfaceDir: 'apps/web/app', feature: 'invoice' });
    const source = sourceOf(files, 'tasks/nightly-sweep.ts');
    expect(source).toContain('orgId');
  });
});

describe('unit · the generated neutral job loads for real', () => {
  test('purge-orphans.ts imports and runs against a real driver', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-job-'));
    try {
      symlinkSync(
        join(workspaceRoot(), 'packages', 'cli', 'node_modules'),
        join(dir, 'node_modules'),
        'dir',
      );
      const files = jobFiles('purge-orphans', {
        ...target,
        sliceEntity: LINKS_ENTITY,
        sliceRepo: LINKS_REPO,
      });
      for (const file of files) {
        if (typeof file.contents === 'string') {
          await Bun.write(sandboxPath(dir, file.path), file.contents);
        }
      }
      const loaded = (await import(
        sandboxPath(dir, 'apps/web/app/links/jobs/purge-orphans.ts')
      )) as {
        readonly purgeOrphans: {
          readonly kind: string;
          readonly tenantFor: (i: unknown) => unknown;
        };
      };
      expect(loaded.purgeOrphans.kind).toBe('job');
      expect(loaded.purgeOrphans.tenantFor({ id: 'x' })).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
