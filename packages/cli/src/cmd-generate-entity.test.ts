// `x g entity`, end to end in a scaffolded app: the repo it writes reads through the typed handle,
// the handle gains the entity, the output says what the new table owes — and the generated repo
// passes its own test against the in-memory driver. The bytes of each template are
// `templates/entity.test.ts`; this file owns the disk and the command surface.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, mkdir, symlink or recursive remove — a throwaway app root is node:fs's.
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path API — nothing native joins a path.
import { join } from 'node:path';
import { ADMIN_FILE } from './admin-registration';
import { REQUIRED_BUN } from './app-root';
import { generateCommand } from './cmd-generate';
import { writeNewApp } from './cmd-new';
import type { CommandContext } from './command';
import { exec } from './exec';
import { ROLES_FILE } from './permission-grants';
import { HANDLE_FILE } from './templates/scaffold-db-client';

/** This package's own workspace links: `@ultimat3/entity`, `core`, `db`, `testing` and the rest. */
const FRAMEWORK = join(import.meta.dir, '..', 'node_modules', '@ultimat3');
const INDEX_FILE = 'packages/db/src/index.ts';

/**
 * Run INSIDE the scaffolded app: its own `defineAdmin()`, asked for the keys it derives for the
 * generated table, against the catalog `x g entity` wrote. The derivation is the admin's, so a
 * generator that spells a key its own way fails here rather than as ⟦key⟧ in a list header.
 */
const ADMIN_KEYS_PROBE = `import { expect, test } from 'bun:test';
import { admin } from './apps/admin/app/admin/admin';
import en from './packages/i18n/catalogs/en.json';

const at = (key: string): unknown =>
  key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      en,
    );

test('every key the admin reads for widgets is in the catalog', () => {
  const resource = admin.resources.find((entry) => entry.name === 'widgets');
  const keys = [resource?.titleKey ?? '', ...(resource?.fields ?? []).map((field) => field.labelKey)];
  expect(keys.length).toBeGreaterThan(3);
  expect(keys.filter((key) => typeof at(key) !== 'string')).toEqual([]);
});
`;

let root = '';

const contextFor = (
  name: string,
  flags: readonly [string, boolean][] = [],
  kind = 'entity',
): CommandContext => ({
  args: {
    command: 'g',
    subcommand: undefined,
    positionals: [kind, name],
    flags: new Map(flags),
    json: false,
    help: false,
    passthrough: [],
  },
  cwd: root,
  runner: exec,
  env: {},
  bunVersion: REQUIRED_BUN,
});

const read = (path: string): Promise<string> => Bun.file(join(root, path)).text();
const filesOf = (data: unknown): readonly string[] =>
  (data as { readonly files?: readonly string[] }).files ?? [];
const nextOf = (data: unknown): readonly string[] | undefined =>
  (data as { readonly next?: readonly string[] }).next;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-generate-entity-'));
  // `--no-example`: the handle starts empty and neither manifest names the other workspace, so
  // the first entity has every edit to make.
  await writeNewApp(root, { name: 'gen', example: false });
  // What `bun install` would have linked. The app's own `@gen/*` resolve through its tsconfig.
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await symlink(FRAMEWORK, join(root, 'node_modules', '@ultimat3'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('unit · x g entity writes a repo over the typed handle', () => {
  // What the dry run said it would touch, held for the run that follows: the two lists are one.
  let plannedFiles: readonly string[] = [];

  test('--dry-run lists every file the run touches — created AND edited — and edits nothing', async () => {
    const before = await read(HANDLE_FILE);
    const roles = await read(ROLES_FILE);
    const result = await generateCommand.run(contextFor('widget', [['dry-run', true]]));
    plannedFiles = filesOf(result.data);
    expect(plannedFiles).toEqual([
      'apps/web/app/widget/entity.ts',
      'apps/web/app/widget/entity.test.ts',
      'apps/web/app/widget/repo.ts',
      'apps/web/app/widget/repo.test.ts',
      'packages/i18n/catalogs/en.json',
      // The edits outside the slice: the dry run named none of them, and the run made all four.
      ROLES_FILE,
      HANDLE_FILE,
      'packages/db/package.json',
      'apps/web/package.json',
    ]);
    // Which of those already exist and are edited rather than created.
    expect((result.data as { readonly edits?: readonly string[] }).edits).toEqual([
      ROLES_FILE,
      HANDLE_FILE,
      'packages/db/package.json',
      'apps/web/package.json',
    ]);
    expect(await read(HANDLE_FILE)).toBe(before);
    expect(await read(ROLES_FILE)).toBe(roles);
    expect(await Bun.file(join(root, 'apps/web/app/widget/repo.ts')).exists()).toBe(false);
  });

  test('the first entity joins the handle, both manifests gain their edge, and next says so', async () => {
    const result = await generateCommand.run(contextFor('widget'));
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(filesOf(result.data)).toContain(HANDLE_FILE);
    // The plan was the run: same files, same order, the re-projected contracts aside.
    const contracts = ['x.manifest.json', 'openapi.json'];
    expect(filesOf(result.data).filter((path) => !contracts.includes(path))).toEqual([
      ...plannedFiles,
    ]);
    const handle = await read(HANDLE_FILE);
    expect(handle).toContain("import { widget } from '@gen/web/app/widget/entity';");
    expect(handle).toContain('const entities = {\n  widgets: widget,\n};');
    // The edges the two new imports are: db reads the entity, the slice reads the handle.
    expect(await read('packages/db/package.json')).toContain('"@gen/web": "0.0.0"');
    expect(await read('apps/web/package.json')).toContain('"@gen/db": "0.0.0"');
    // Each one runs as printed, in the order it has to happen.
    const next = ['bun install', 'bunx x db gen "create widgets"', 'bunx x db migrate'];
    expect(nextOf(result.data)).toEqual(next);
    expect(result.summary).toEndWith(`next: ${next.join(' && ')}`);
  });

  test('the repo it wrote has no SQL text, no row decoding and no tenant predicate in SQL', async () => {
    const repo = await read('apps/web/app/widget/repo.ts');
    expect(repo).not.toContain('sql`');
    expect(repo).not.toContain('decodeRow');
    expect(repo).not.toContain('org_id');
    expect(repo).not.toContain("'@ultimat3/db'");
    expect(repo).toContain("import { db } from '@gen/db';");
  });

  // One subprocess for both: the generated repo's own test, and the app's real admin asked which
  // keys it reads for the new entity — the entity is an admin screen the moment it is in the handle.
  test('the generated repo passes its own test, and the admin finds every label it reads', async () => {
    await Bun.write(join(root, 'admin-keys.test.ts'), ADMIN_KEYS_PROBE);
    const run = await exec(
      [
        'bun',
        'test',
        './apps/web/app/widget/repo.test.ts',
        './packages/db/src/client.test.ts',
        './admin-keys.test.ts',
      ],
      { cwd: root },
    );
    expect(`${run.stdout}${run.stderr}`).toContain(' 0 fail');
    expect(`${run.stdout}${run.stderr}`).toContain(' 8 pass');
    expect(run.ok).toBe(true);
  }, 30_000);

  test('a second entity lands in key order, and owes no install', async () => {
    const result = await generateCommand.run(contextFor('gadget'));
    expect(result.ok).toBe(true);
    expect(await read(HANDLE_FILE)).toContain(
      'const entities = {\n  gadgets: gadget,\n  widgets: widget,\n};',
    );
    expect(nextOf(result.data)).toEqual(['bunx x db gen "create gadgets"', 'bunx x db migrate']);
  });

  test('a handle with no entity set is X_DB_HANDLE_UNREGISTERED, naming both lines', async () => {
    const handle = await read(HANDLE_FILE);
    const inline = handle
      .replace(/const entities = \{[^}]*\};\n/, '')
      .replace('database(entities, { driver })', 'database({ widgets: widget }, { driver })');
    await Bun.write(join(root, HANDLE_FILE), inline);
    const result = await generateCommand.run(contextFor('sprocket'));
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.code)).toEqual(['X_DB_HANDLE_UNREGISTERED']);
    const fix = result.findings?.[0]?.fix ?? '';
    expect(fix).toContain("import { sprocket } from '@gen/web/app/sprocket/entity';");
    expect(fix).toContain('"sprockets: sprocket,"');
    expect(result.findings?.[0]?.at).toBe(HANDLE_FILE);
    // The slice is on disk — the finding is what is left to do — and no next step is promised.
    expect(await Bun.file(join(root, 'apps/web/app/sprocket/repo.ts')).exists()).toBe(true);
    expect(await read(HANDLE_FILE)).toBe(inline);
    expect(nextOf(result.data)).toBeUndefined();
    await Bun.write(join(root, HANDLE_FILE), handle);
  });

  test('--admin lists the override under resources: in the app admin, with its import', async () => {
    const result = await generateCommand.run(contextFor('gizmo', [['admin', true]], 'resource'));
    expect(result.findings).toEqual([]);
    expect(filesOf(result.data)).toContain(ADMIN_FILE);
    const admin = await read(ADMIN_FILE);
    expect(admin).toContain(
      "import { gizmoAdminResource } from '@gen/web/app/gizmo/admin/resource';",
    );
    expect(admin).toContain('  resources: {\n    gizmos: gizmoAdminResource,\n  },\n});');
    expect(await read('apps/admin/package.json')).toContain('"@gen/web": "0.0.0"');
  });

  test('with no --locales, the labels land in every locale the app has a catalog for', async () => {
    await Bun.write(join(root, 'packages/i18n/catalogs/es.json'), '{}\n');
    // Not a locale: some other JSON an app keeps beside its catalogs is never written to.
    await Bun.write(join(root, 'packages/i18n/catalogs/glossary_v2.json'), '{}\n');
    const result = await generateCommand.run(contextFor('lever'));
    expect(result.ok).toBe(true);
    // `es` holds the same keys, each the default string inside the placeholder marker — what
    // `x i18n add es` would have seeded, so `x i18n check` counts them as still owed.
    for (const [locale, wrap] of [
      ['en', (text: string) => text],
      ['es', (text: string) => `\u27E6${text}\u27E7`],
    ] as const) {
      const catalog = JSON.parse(await read(`packages/i18n/catalogs/${locale}.json`)) as {
        admin: Record<string, unknown>;
      };
      expect(catalog.admin['levers']).toMatchObject({
        title: wrap('Levers'),
        field: { title: wrap('Title') },
      });
    }
    expect(await read('packages/i18n/catalogs/glossary_v2.json')).toBe('{}\n');
  });

  test('an index that does not export the handle is named, with the line', async () => {
    const index = await read(INDEX_FILE);
    await Bun.write(
      join(root, INDEX_FILE),
      "export { db, sql, withTransaction } from '@ultimat3/db';\n",
    );
    const result = await generateCommand.run(contextFor('flange'));
    expect(result.ok).toBe(false);
    const finding = result.findings?.find((entry) => entry.at === INDEX_FILE);
    expect(finding?.code).toBe('X_DB_HANDLE_UNREGISTERED');
    expect(finding?.fix).toContain("export { db, driver, selectDriver } from './client';");
    // The handle itself was still extended: one finding, about the one thing that is wrong.
    expect(await read(HANDLE_FILE)).toContain('  flanges: flange,');
    await Bun.write(join(root, INDEX_FILE), index);
  });
});
