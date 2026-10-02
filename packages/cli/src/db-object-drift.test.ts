// `x db migrate`'s second look, against a real embedded dev database on disk: a trigger and a
// function made by hand — in no migration — are reported once the connection `runMigrations`
// held is gone, which is the only moment this module runs.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { raw } from '@ultimat3/db';
import { type CatalogDescription, emptyCatalog } from '@ultimat3/db/schema-dump';
import { liveObjectDrift } from './db-object-drift';
import { resolveServices } from './runtime-bindings';
import { startQueue } from './runtime-queue';

// An initdb on disk, then a reopen. A hang detector, not a budget.
const BOOT_MS = 120_000;

describe('liveObjectDrift · a real embedded dev database', () => {
  const root = mkdtempSync(join(tmpdir(), 'x-object-drift-'));
  const env = { ULTIMATE_STATE_DIR: join(root, '.x') };

  beforeAll(async () => {
    // What a developer does in psql and never writes down.
    const queue = await startQueue(resolveServices(root, env), undefined, env);
    try {
      for (const statement of [
        'create table posts (id uuid primary key, title text not null)',
        'create function touch() returns trigger language plpgsql as $$ begin return new; end $$',
        'create trigger posts_touch before update on posts for each row execute function touch()',
      ]) {
        await queue.db.execute(raw(statement));
      }
    } finally {
      await queue.stop();
    }
  }, BOOT_MS);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test(
    'a hand-created trigger and its function are X_DB_DRIFT differences; the framework’s own tables are not',
    async () => {
      const differences = await liveObjectDrift(root, env, emptyCatalog());
      expect(differences.map((difference) => [difference.kind, difference.cause])).toEqual([
        [
          'unexpected-object',
          'function "touch" exists in this database and no migration creates it',
        ],
        [
          'unexpected-object',
          'trigger "posts_touch" on table "posts" exists in this database and no migration creates it',
        ],
      ]);
    },
    BOOT_MS,
  );

  test(
    'what the migrations do create is silence, and the database is released for the next command',
    async () => {
      const expected: CatalogDescription = {
        ...emptyCatalog(),
        functions: [{ name: 'touch', arguments: '', definition: '' }],
        triggers: [{ table: 'posts', name: 'posts_touch', definition: '', enabled: 'O' }],
      };
      expect(await liveObjectDrift(root, env, expected)).toEqual([]);
      // A second call can open the same directory: the first one let go of it.
      expect(await liveObjectDrift(root, env, expected)).toEqual([]);
    },
    BOOT_MS,
  );
});
