// The edit `x g entity` makes to the app's typed handle, as a pure function over its source: the
// entity is listed where `database()` reads it, imported where the formatter would put it, and a
// file that is not the scaffold's shape is refused with the two lines rather than guessed at.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove, so a throwaway app root's lifetime is node:fs's.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path API — nothing native joins a path.
import { join } from 'node:path';
import {
  handleUnregisteredFinding,
  insertHandleEntries,
  registerGeneratedEntities,
  resolveDbModule,
  withHandleEntries,
} from './handle-registration';
import type { HandleEntry } from './templates/scaffold-db-client';
import { dbClientSource, HANDLE_FILE } from './templates/scaffold-db-client';

const entry = (name: string, scope = '@shop'): HandleEntry => ({
  key: `${name}s`,
  binding: name,
  specifier: `${scope}/web/app/${name}/entity`,
});

const POST = entry('post');
const WIDGET = entry('widget');

describe('unit · listing an entity in the handle', () => {
  test('the entry and its import land in order, between the lines already there', () => {
    const before = dbClientSource([POST, entry('zebra')]);
    const { source, missing } = insertHandleEntries(before, [WIDGET]);
    expect(missing).toEqual([]);
    expect(source).toContain(
      'const entities = {\n  posts: post,\n  widgets: widget,\n  zebras: zebra,\n};',
    );
    // Byte-equal to the file `x new` would have written with all three: one shape, two writers.
    expect(source).toBe(dbClientSource([POST, WIDGET, entry('zebra')]));
  });

  test('an empty set is expanded, and a one-line set is too', () => {
    expect(insertHandleEntries(dbClientSource([]), [WIDGET]).source).toBe(dbClientSource([WIDGET]));
    const oneLine = dbClientSource([POST]).replace(
      'const entities = {\n  posts: post,\n};',
      'const entities = { posts: post };',
    );
    expect(insertHandleEntries(oneLine, [WIDGET]).source).toContain(
      'const entities = {\n  posts: post,\n  widgets: widget,\n};',
    );
  });

  test('an entity already listed is left alone — a second run changes nothing', () => {
    const once = insertHandleEntries(dbClientSource([POST]), [WIDGET]).source;
    expect(insertHandleEntries(once, [WIDGET, POST])).toEqual({ source: once, missing: [] });
  });

  test('a scope that sorts after the framework goes after it, and before a relative import', () => {
    const zeta = entry('widget', '@zeta');
    const source = `${dbClientSource([]).replace(
      "from '@ultimat3/entity';\n",
      "from '@ultimat3/entity';\nimport { tag } from './tags';\n",
    )}`;
    const lines = insertHandleEntries(source, [zeta])
      .source.split('\n')
      .filter((line) => line.startsWith('import '));
    expect(lines.map((line) => line.slice(line.indexOf("'")))).toEqual([
      "'@ultimat3/core';",
      "'@ultimat3/entity';",
      "'@zeta/web/app/widget/entity';",
      "'./tags';",
    ]);
  });

  test('a set written inline is not guessed at: the entry comes back as missing', () => {
    const inline = 'export const db = database({ posts }, { driver });\n';
    expect(insertHandleEntries(inline, [WIDGET])).toEqual({ source: inline, missing: [WIDGET] });
    // Named, but declared in another module: there is no literal here to add a line to.
    const imported = "import { entities } from './set';\nexport const db = database(entities);\n";
    expect(insertHandleEntries(imported, [WIDGET]).missing).toEqual([WIDGET]);
    const finding = handleUnregisteredFinding(WIDGET, 'has no set');
    expect(finding.code).toBe('X_DB_HANDLE_UNREGISTERED');
    expect(finding.fix).toContain("import { widget } from '@shop/web/app/widget/entity';");
    expect(finding.fix).toContain('"widgets: widget,"');
    expect(finding.fix).toContain(HANDLE_FILE);
  });

  test('a file list is registered the way the disk is: one handle, every entity in it', () => {
    const entity = (name: string) => ({
      path: `apps/web/app/${name}/entity.ts`,
      contents: `export const ${name} = entity('${name}s', { columns: {} });\n`,
    });
    const files = withHandleEntries(
      [
        { path: HANDLE_FILE, contents: dbClientSource([]) },
        entity('invoice'),
        entity('receipt'),
        // Not an entity module, and not one by export: neither is listed.
        { path: 'apps/web/app/invoice/repo.ts', contents: 'export const x = entity(1);\n' },
        { path: 'apps/web/app/empty/entity.ts', contents: 'export type Nothing = never;\n' },
      ],
      '@shop/db',
    );
    expect(files.find((file) => file.path === HANDLE_FILE)?.contents).toBe(
      dbClientSource([entry('invoice'), entry('receipt')]),
    );
  });
});

describe('unit · registering on disk', () => {
  let root = '';
  const write = (path: string, contents: string) => Bun.write(join(root, path), contents);
  const read = (path: string) => Bun.file(join(root, path)).text();
  const ENTITY = 'apps/web/app/widget/entity.ts';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'x-handle-'));
    await write('packages/db/package.json', '{\n  "name": "@shop/db",\n  "version": "0.0.0"\n}\n');
    await write('apps/web/package.json', '{\n  "name": "@shop/web",\n  "version": "0.0.0"\n}\n');
    await write(ENTITY, "export const widget = entity('widgets', { columns: {} });\n");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('the db package names the module a repo imports the handle from', async () => {
    expect(await resolveDbModule(root)).toBe('@shop/db');
    expect(await resolveDbModule(join(root, 'apps'))).toBeUndefined();
  });

  test('a run that wrote no entity edits nothing', async () => {
    const result = await registerGeneratedEntities(
      root,
      ['apps/web/app/widget/policy.ts'],
      '@shop/db',
    );
    expect(result).toEqual({ edited: [], findings: [] });
    expect(await Bun.file(join(root, HANDLE_FILE)).exists()).toBe(false);
  });

  test('an app with no handle gets one, both edges, and the line its index still owes', async () => {
    const result = await registerGeneratedEntities(root, [ENTITY], '@shop/db');
    expect(result.edited).toEqual([
      HANDLE_FILE,
      'packages/db/package.json',
      'apps/web/package.json',
    ]);
    expect(await read(HANDLE_FILE)).toBe(dbClientSource([WIDGET]));
    expect(await read('packages/db/package.json')).toContain('"@shop/web": "0.0.0"');
    expect(await read('apps/web/package.json')).toContain('"@shop/db": "0.0.0"');
    // No index.ts exports `./client` yet: the repo's import would reach something else.
    expect(result.findings.map((finding) => finding.at)).toEqual(['packages/db/src/index.ts']);
    expect(result.findings[0]?.fix).toContain(
      "export { db, driver, selectDriver } from './client';",
    );
  });

  test('once the index exports the handle, a second run is silent and edits nothing', async () => {
    await write(
      'packages/db/src/index.ts',
      "export { db, driver, selectDriver } from './client';\n",
    );
    expect(await registerGeneratedEntities(root, [ENTITY], '@shop/db')).toEqual({
      edited: [],
      findings: [],
    });
  });

  test('a db package with no name is said so, with the line to add', async () => {
    const result = await registerGeneratedEntities(root, [ENTITY], undefined);
    expect(result.findings.map((finding) => finding.at)).toEqual(['packages/db/package.json']);
    expect(result.findings[0]?.code).toBe('X_DB_HANDLE_UNREGISTERED');
  });
});

describe('unit · a registration that cannot be made writes nothing', () => {
  let root = '';
  const write = (path: string, contents: string) => Bun.write(join(root, path), contents);
  const read = (path: string) => Bun.file(join(root, path)).text();
  const ENTITY = 'apps/web/app/widget/entity.ts';
  const DB_MANIFEST = '{\n  "name": "@shop/db",\n  "version": "0.0.0"\n}\n';
  const WEB_MANIFEST = '{\n  "name": "@shop/web",\n  "version": "0.0.0"\n}\n';
  // A handle whose entities live in the db package and are handed to `database()` inline: the
  // reference app's shape, and no `const <set> = { … }` for the registrar to add a line to.
  const INLINE_HANDLE =
    "import { database } from '@ultimat3/entity';\nimport { posts } from './schema/posts';\n\nexport const db = database({ posts });\n";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'x-handle-atomic-'));
    await write('packages/db/package.json', DB_MANIFEST);
    await write('apps/web/package.json', WEB_MANIFEST);
    await write('packages/db/src/index.ts', "export { db } from './client';\n");
    await write(HANDLE_FILE, INLINE_HANDLE);
    await write(ENTITY, "export const widget = entity('widgets', { columns: {} });\n");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('the handle refuses the entry: no manifest is edited, and the finding carries the lines', async () => {
    const result = await registerGeneratedEntities(root, [ENTITY], '@shop/db');
    expect(result.findings.map((finding) => finding.code)).toEqual(['X_DB_HANDLE_UNREGISTERED']);
    expect(result.findings[0]?.fix).toContain(
      "import { widget } from '@shop/web/app/widget/entity';",
    );
    // The run that could not register left a `packages/db` → app edge behind: a manifest line for
    // an import that was never written, pointing UP from the db package to the app.
    expect(result.edited).toEqual([]);
    expect(await read('packages/db/package.json')).toBe(DB_MANIFEST);
    expect(await read('apps/web/package.json')).toBe(WEB_MANIFEST);
    expect(await read(HANDLE_FILE)).toBe(INLINE_HANDLE);
  });

  test('the db manifest names the app only when the handle really imports from it', async () => {
    // The same app once its handle has the anchor: the import lands, and the edge it needs with it.
    await write(HANDLE_FILE, dbClientSource([]));
    await write(
      'packages/db/src/index.ts',
      "export { db, driver, selectDriver } from './client';\n",
    );
    const result = await registerGeneratedEntities(root, [ENTITY], '@shop/db');
    expect(result.findings).toEqual([]);
    expect(result.edited).toEqual([
      HANDLE_FILE,
      'packages/db/package.json',
      'apps/web/package.json',
    ]);
    expect(await read(HANDLE_FILE)).toContain("from '@shop/web/app/widget/entity';");
    expect(await read('packages/db/package.json')).toContain('"@shop/web": "0.0.0"');
  });
});

// The set was closed at the first `}` in the raw text: one in a comment cut the set short and the
// entry was written into the middle of it.
describe('unit · a commented entity set is added to, and every comment survives', () => {
  const COMMENTED = [
    "import { database } from '@ultimat3/entity';",
    "import { post } from '@shop/web/app/post/entity';",
    '',
    'const entities = {',
    "  // the blog's own table — `database({ … })` reads it; don't inline it",
    '  posts: post,',
    '};',
    '',
    'export const db = database(entities, { driver });',
    '',
  ].join('\n');

  test('the entry lands in the set, in key order, below the comment', () => {
    const { source, missing } = insertHandleEntries(COMMENTED, [WIDGET]);
    expect(missing).toEqual([]);
    expect(source).toContain(
      "  // the blog's own table — `database({ … })` reads it; don't inline it\n  posts: post,\n  widgets: widget,\n};",
    );
    expect(insertHandleEntries(source, [WIDGET]).source).toBe(source);
  });

  test('a set this cannot add a line to safely is refused: the entry comes back as missing', () => {
    // An entry whose value spans rows and closes on a row shaped like an entry.
    const odd = COMMENTED.replace('  posts: post,', '  posts: wrap({\n    zebra: post,\n  }),');
    const { source, missing } = insertHandleEntries(odd, [WIDGET]);
    // The line edit would have put `widgets` INSIDE `wrap({ … })`; read back, that is not the
    // set plus one entry, so nothing is written and the finding names the two lines.
    expect(missing).toEqual([WIDGET]);
    expect(source).toBe(odd);
  });
});
