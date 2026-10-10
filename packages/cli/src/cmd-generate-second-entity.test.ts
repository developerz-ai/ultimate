// A feature with more than one table, and an app whose db package is its own. `x g entity
// blog-attempt --feature blog` answered X_GENERATE_CONFLICT on the first entity's four files —
// with `--force` as the fix, which would have written the second table OVER the first — so two
// entities were declared by hand beside a generated one. And in an app whose `packages/db` is a
// schema and a seed, the same run wrote a `client.ts` nothing imports.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, mkdir, symlink or recursive remove — a throwaway app root is node:fs's.
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path API — nothing native joins a path.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { generateCommand } from './cmd-generate';
import { writeNewApp } from './cmd-new';
import type { CommandContext } from './command';
import { exec } from './exec';
import { ROLES_FILE } from './permission-grants';
import { HANDLE_FILE } from './templates/scaffold-db-client';

const FRAMEWORK = join(import.meta.dir, '..', 'node_modules', '@ultimat3');
const SLICE = 'apps/web/app/blog';

/**
 * Run INSIDE the app: the registry `x db gen` diffs (`describeEntities()`), filled the way the
 * handle fills it. A sibling module the handle does not import would be a table no migration has.
 */
const REGISTRY_PROBE = `import { expect, test } from 'bun:test';
import { describeEntities } from '@ultimat3/entity';
import { db } from './packages/db/src/client';

test('every entity of the feature is on the handle and in the registry x db gen reads', () => {
  expect(Object.keys(db)).toEqual(expect.arrayContaining(['blogPosts', 'blogAttempts', 'blogKeywordBatches']));
  const tables = describeEntities().map((entity) => entity.name);
  expect(tables).toEqual(expect.arrayContaining(['blog_posts', 'blog_attempts', 'blog_keyword_batches']));
});
`;

const newApp = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await writeNewApp(root, { name: 'gen', example: false });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await symlink(FRAMEWORK, join(root, 'node_modules', '@ultimat3'));
  return root;
};

const contextFor = (
  root: string,
  name: string,
  flags: readonly [string, boolean | string][] = [],
): CommandContext => ({
  args: {
    command: 'g',
    subcommand: undefined,
    positionals: ['entity', name],
    flags: new Map<string, boolean | string>([['feature', 'blog'], ...flags]),
    json: false,
    help: false,
    passthrough: [],
  },
  cwd: root,
  runner: exec,
  env: {},
  bunVersion: REQUIRED_BUN,
});

const filesOf = (data: unknown): readonly string[] =>
  (data as { readonly files?: readonly string[] }).files ?? [];
const nextOf = (data: unknown): readonly string[] | undefined =>
  (data as { readonly next?: readonly string[] }).next;

describe('unit · x g entity --feature: the first entity and every one after it', () => {
  let root = '';
  const read = (path: string): Promise<string> => Bun.file(join(root, path)).text();

  beforeAll(async () => {
    root = await newApp('x-generate-second-entity-');
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('the first entity of a feature is entity.ts + repo.ts', async () => {
    const result = await generateCommand.run(contextFor(root, 'blog-post'));
    expect(result.findings).toEqual([]);
    expect(filesOf(result.data).slice(0, 4)).toEqual([
      `${SLICE}/entity.ts`,
      `${SLICE}/entity.test.ts`,
      `${SLICE}/repo.ts`,
      `${SLICE}/repo.test.ts`,
    ]);
  });

  test('the second lands BESIDE it as entity-<name>.ts + repo-<name>.ts; the first is untouched', async () => {
    const first = await read(`${SLICE}/entity.ts`);
    const repo = await read(`${SLICE}/repo.ts`);
    const planned = await generateCommand.run(
      contextFor(root, 'blog-attempt', [['dry-run', true]]),
    );
    const result = await generateCommand.run(contextFor(root, 'blog-attempt'));
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(filesOf(result.data).slice(0, 4)).toEqual([
      `${SLICE}/entity-blog-attempt.ts`,
      `${SLICE}/entity-blog-attempt.test.ts`,
      `${SLICE}/repo-blog-attempt.ts`,
      `${SLICE}/repo-blog-attempt.test.ts`,
    ]);
    // The dry run before it named the same files, the edited ones included.
    const contracts = ['x.manifest.json', 'openapi.json'];
    expect(filesOf(planned.data)).toEqual(
      filesOf(result.data).filter((path) => !contracts.includes(path)),
    );
    expect(filesOf(planned.data)).toEqual(expect.arrayContaining([ROLES_FILE, HANDLE_FILE]));
    expect(await read(`${SLICE}/entity.ts`)).toBe(first);
    expect(await read(`${SLICE}/repo.ts`)).toBe(repo);
    // Each sibling reads its own module, never the slice's first.
    expect(await read(`${SLICE}/repo-blog-attempt.ts`)).toContain(
      "import type { BlogAttempt } from './entity-blog-attempt';",
    );
    expect(await read(`${SLICE}/repo-blog-attempt.test.ts`)).toContain(
      "import * as repo from './repo-blog-attempt';",
    );
    expect(await read(`${SLICE}/entity-blog-attempt.ts`)).toContain("entity('blog_attempts', {");
    // The table it owes a migration for is the ENTITY's, not the feature's.
    expect(nextOf(result.data)).toEqual([
      'bunx x db gen "create blog_attempts"',
      'bunx x db migrate',
    ]);
  });

  test('it joins the handle, the role map and the catalog exactly as a first entity does', async () => {
    const handle = await read(HANDLE_FILE);
    expect(handle).toContain(
      "import { blogAttempt } from '@gen/web/app/blog/entity-blog-attempt';",
    );
    expect(handle).toContain('  blogAttempts: blogAttempt,\n  blogPosts: blogPost,\n');
    const roles = await read(ROLES_FILE);
    for (const verb of ['read', 'write', 'delete']) {
      // Declared once and granted once.
      expect(roles.split(`'blog_attempts:${verb}'`)).toHaveLength(3);
    }
    const catalog = JSON.parse(await read('packages/i18n/catalogs/en.json')) as {
      admin: Record<string, { title: string }>;
    };
    expect(catalog.admin['blog_attempts']?.title).toBe('Blog attempts');
  });

  test('the Nth is one more pair of siblings', async () => {
    const result = await generateCommand.run(contextFor(root, 'blog-keyword-batch'));
    expect(result.findings).toEqual([]);
    expect(filesOf(result.data)).toContain(`${SLICE}/entity-blog-keyword-batch.ts`);
    expect(await read(HANDLE_FILE)).toContain('  blogKeywordBatches: blogKeywordBatch,\n');
  });

  test('the SAME entity again is still a conflict — on its own files, never on a sibling’s', async () => {
    const first = await generateCommand.run(contextFor(root, 'blog-post'));
    expect(first.ok).toBe(false);
    expect(first.findings?.map((finding) => finding.at)).toContain(`${SLICE}/entity.ts`);
    const sibling = await generateCommand.run(contextFor(root, 'blog-attempt'));
    expect(sibling.ok).toBe(false);
    expect(sibling.findings?.map((finding) => finding.at)).toEqual([
      `${SLICE}/entity-blog-attempt.ts`,
      `${SLICE}/entity-blog-attempt.test.ts`,
      `${SLICE}/repo-blog-attempt.ts`,
      `${SLICE}/repo-blog-attempt.test.ts`,
    ]);
  });

  test('every one passes its own tests, and x db gen’s registry holds all three tables', async () => {
    await Bun.write(join(root, 'registry.test.ts'), REGISTRY_PROBE);
    const run = await exec(
      [
        'bun',
        'test',
        `./${SLICE}/repo.test.ts`,
        `./${SLICE}/entity-blog-attempt.test.ts`,
        `./${SLICE}/repo-blog-attempt.test.ts`,
        `./${SLICE}/repo-blog-keyword-batch.test.ts`,
        './registry.test.ts',
      ],
      { cwd: root },
    );
    expect(`${run.stdout}${run.stderr}`).toContain(' 0 fail');
    expect(run.ok).toBe(true);
  }, 30_000);
});

/** A role map with comments, apostrophes in them, and no `admin` role: the app's own. */
const OWN_ROLES = `import { definePermissions, defineRoles } from '@ultimat3/policy';

export const appPermissions = definePermissions([
  'dashboard:read',
  // every member reads the firm's terms; owners can't skip it
  'deadline:read',
]);

export const roles = defineRoles({
  // The firm's own roles — there isn't an admin here.
  owner: {
    grants: ['dashboard:read', 'deadline:read'],
  },
});
`;

describe('unit · an app whose db package and role map are its own', () => {
  let root = '';
  const INDEX = 'packages/db/src/index.ts';
  const OWN_INDEX =
    "export { db, sql } from '@ultimat3/db';\nexport * as schema from './schema';\n";

  beforeAll(async () => {
    root = await newApp('x-generate-own-db-');
    // The pre-handle layout: an index over `@ultimat3/db`'s client and a schema, no `client.ts`.
    await rm(join(root, HANDLE_FILE));
    await rm(join(root, 'packages/db/src/client.test.ts'));
    await Bun.write(join(root, INDEX), OWN_INDEX);
    await Bun.write(join(root, ROLES_FILE), OWN_ROLES);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const dry of [true, false]) {
    test(`${dry ? '--dry-run' : 'the run'}: no client.ts is written, the role map is byte-identical, both are said`, async () => {
      const result = await generateCommand.run(
        contextFor(root, 'blog-post', dry ? [['dry-run', true]] : []),
      );
      expect(result.ok).toBe(false);
      expect(filesOf(result.data)).not.toContain(HANDLE_FILE);
      expect(await Bun.file(join(root, HANDLE_FILE)).exists()).toBe(false);
      expect(await Bun.file(join(root, INDEX)).text()).toBe(OWN_INDEX);
      // No `admin` role to grant to, so nothing is DECLARED either: three permissions no role
      // holds were added to a file whose comments the same edit then corrupted.
      expect(await Bun.file(join(root, ROLES_FILE)).text()).toBe(OWN_ROLES);
      expect(filesOf(result.data)).not.toContain(ROLES_FILE);
      const findings = result.findings ?? [];
      expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
        ['X_DB_HANDLE_UNREGISTERED', INDEX],
        ['X_PERMISSION_UNGRANTED', ROLES_FILE],
      ]);
      // Each says exactly what to add by hand.
      expect(findings[0]?.fix).toContain("import { blogPost } from '@gen/web/app/blog/entity';");
      expect(findings[1]?.fix).toContain(
        "admin: 'blog_posts:read', 'blog_posts:write', 'blog_posts:delete'",
      );
    });
  }
});
