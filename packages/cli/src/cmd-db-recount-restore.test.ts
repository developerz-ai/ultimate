// `x db recount` puts the process's `db()` back when it closes its own client, as
// `x db diagnostics` does: `startDb` installs the command's client, and an embedding process (the
// MCP host, the next test file on a shared worker) otherwise reaches a closed pool.

import { afterAll, expect, test } from 'bun:test';
// why: Bun has no mkdtemp; the scratch app must be a fresh directory per run.
import { mkdtemp, rm } from 'node:fs/promises';
// why: the scratch app lives under the OS temp directory, which only node:os names.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { baseClient, type DbClient, setDbClient } from '@ultimat3/db';
import { entity, integer, uuid } from '@ultimat3/entity';
import { isolateEntityRegistry } from '@ultimat3/testing/registry-isolation';
import { runRecountCommand } from './cmd-db-recount';
import { dbSpec } from './cmd-db-spec';
import type { CommandContext } from './command';
import { exec } from './exec';
import { parseArgs } from './parse';

const root = await mkdtemp(join(tmpdir(), 'x-db-recount-restore-'));
await Bun.write(join(root, 'app.config.ts'), 'export const config = {};\n');
await Bun.write(join(root, 'package.json'), '{ "name": "scratch", "version": "0.0.0" }\n');
afterAll(async () => {
  setDbClient(undefined);
  await rm(root, { recursive: true, force: true });
});

/** What the process held before the command: never asked, only compared by identity. */
const sentinel: DbClient = {
  query: () => expect.unreachable('the sentinel client was asked a query'),
  execute: () => expect.unreachable('the sentinel client was asked a statement'),
  close: () => Promise.resolve(),
} as unknown as DbClient;

/** A WASM compile plus an initdb — a hang detector, not a budget. */
const PGLITE_BOOT_MS = 120_000;

test(
  'the client the process held before the recount is db() again after it',
  async () => {
    const restoreEntities = isolateEntityRegistry();
    setDbClient(sentinel);
    try {
      const parents = entity('rcr_parents', {
        columns: { id: uuid().primaryKey(), kids: integer().default(0) },
      });
      entity('rcr_kids', {
        columns: {
          id: uuid().primaryKey(),
          parentId: uuid().references(() => parents.id, { countedIn: () => parents.kids }),
        },
      });
      // The scratch database has no tables, so the sweep refuses: the restore is a `finally`'s.
      const outcome = await runRecountCommand(
        {
          args: parseArgs(['db', 'recount', 'rcr_parents.kids'], [dbSpec]),
          cwd: root,
          runner: exec,
          env: {},
          bunVersion: Bun.version,
        } satisfies CommandContext,
        root,
      ).then(
        () => 'answered',
        () => 'refused',
      );
      expect(outcome).toBe('refused');
      expect(baseClient()).toBe(sentinel);
    } finally {
      restoreEntities();
    }
  },
  PGLITE_BOOT_MS,
);
