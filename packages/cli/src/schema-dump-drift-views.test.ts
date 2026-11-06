// The dump rail's view half, wired: a replay that created a view holds the app's view entities to
// its output columns (`X_ENTITY_VIEW_DRIFT`), and a replay with no view never loads the app.

import { afterEach, beforeEach, expect, test } from 'bun:test';
// why: Bun has no temp-directory API and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import type { EntityDescriptionLike } from '@ultimat3/db';
import {
  type CatalogDescription,
  emptyCatalog,
  type SchemaDumpFile,
} from '@ultimat3/db/schema-dump';
import { writeSchemaDump } from './db-schema-dump';
import { MIGRATIONS_DIR } from './migrations';
import type { DeclaredEntities } from './schema-drift';
import { checkSchemaDump, type SchemaReplay } from './schema-dump-drift';

const FILES: readonly SchemaDumpFile[] = [
  { path: '07_views/totals.sql', content: 'create view "totals" as\nSELECT 1 AS likes;\n' },
];

const VIEWS: CatalogDescription = {
  ...emptyCatalog(),
  views: [
    {
      name: 'totals',
      materialized: false,
      options: null,
      definition: 'SELECT 1;',
      columns: ['likes'],
    },
  ],
};

const totals: EntityDescriptionLike = {
  name: 'totals',
  table: 'totals',
  primaryKey: ['post_id'],
  columns: [
    {
      property: 'postId',
      column: 'post_id',
      kind: 'uuid',
      notNull: true,
      primaryKey: true,
      unique: false,
      hasDefault: false,
      check: null,
      references: null,
    },
  ],
  indexes: [],
  view: { sql: 'select 1 as likes' },
};

const replaying =
  (catalog: CatalogDescription): SchemaReplay =>
  async () => ({ catalog, files: FILES, reload: [] });

let root = '';
let loads = 0;
const declared: DeclaredEntities = async () => {
  loads += 1;
  return [totals];
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'x-dump-views-'));
  loads = 0;
  await Bun.write(join(root, MIGRATIONS_DIR, '0001_init.sql'), 'create view totals as select 1;\n');
  await writeSchemaDump(root, FILES);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('a view entity naming a column its view does not output is X_ENTITY_VIEW_DRIFT', async () => {
  const findings = await checkSchemaDump(root, {}, replaying(VIEWS), declared);
  expect(findings.map((finding) => finding.code)).toEqual(['X_ENTITY_VIEW_DRIFT']);
  expect(findings[0]?.cause).toContain('declares "post_id", which view "totals" does not output');
});

test('a replay that created no view never loads the app', async () => {
  expect(await checkSchemaDump(root, {}, replaying(emptyCatalog()), declared)).toEqual([]);
  expect(loads).toBe(0);
});
