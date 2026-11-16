// A fix is run, not read. `fix-command.ts` proves a fix names a real command, across every code; this
// proves, for the codes below, that running it helps: each row breaks a scaffolded app, asserts the
// code, EXECUTES the printed line through a shell, and requires the failure gone or a stated next
// refusal. Exit 0 with the original failure still there is the bug this exists for.
//
// A false fix found later adds a row, in the diff that repairs it. Opt-in by design: most fixes need a
// database, a deploy or a secret, so this is a table of the ones that do not.
//
// FX1, the costliest row, runs over its own scaffold in `fix-truth-barrel.test.ts`; the rows are
// `fix-truth-rows-fixture.ts`'s, so the two files run side by side.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { auditLedger, checksumOf, type LedgerRow } from '@ultimat3/db';
import { emptyCatalog } from '@ultimat3/db/schema-dump';
import { readSchemaDump, SCHEMA_DUMP_DIR } from './db-schema-dump';
import { type FixtureApp, fixtureApp, GIT } from './fix-truth-fixture';
import { fixTruthRows, ROW_MS } from './fix-truth-rows-fixture';
import { MIGRATIONS_DIR, readMigrations } from './migrations';
import type { Finding } from './output';
import { checkSchemaDump } from './schema-dump-drift';

let app: FixtureApp;

beforeAll(async () => {
  app = await fixtureApp();
}, ROW_MS);

afterAll(() => app.remove());

const rows = fixTruthRows(() => app);
const { write } = rows;

describe('a printed fix, executed', () => {
  test.each(rows.rest.map((row) => [row.name, row] as const))(
    '%s',
    (_name, row) => rows.run(row),
    ROW_MS,
  );
});

/** A migration, its snapshot and the dump it produced, as `x db gen` leaves them, committed. */
const COLUMN_DUMP = (columns: readonly string[]): string =>
  [
    'create table "truth" (',
    ...columns.map((name) => `  "${name}" text,`),
    '  constraint "c" PRIMARY KEY (id)',
    ');',
    '',
  ].join('\n');

describe('D2 · an applied migration, edited', () => {
  const ID = '0001_truth';
  const SQL = `${MIGRATIONS_DIR}/${ID}.sql`;
  const PRISTINE = 'create table truth (id text);\n';

  beforeAll(async () => {
    await write(SQL, PRISTINE);
    await write(
      `${MIGRATIONS_DIR}/${ID}.snapshot.json`,
      JSON.stringify({
        tables: [
          {
            schema: 'public',
            name: 'truth',
            columns: [{ name: 'id', dataType: 'text', nullable: true, default: null, position: 1 }],
            primaryKey: [],
            indexes: [],
            foreignKeys: [],
          },
        ],
      }),
    );
    await write(`${SCHEMA_DUMP_DIR}/04_tables/truth.sql`, COLUMN_DUMP(['id']));
    await app.sh(
      'git add -A && git -c user.name=t -c user.email=t@example.com commit -qm migrated',
    );
  }, ROW_MS);

  afterAll(async () => {
    await app.reset();
  });

  /** The replay is the dump itself: this row is about the snapshot rail, and a boot is seconds. */
  const drift = async (): Promise<readonly Finding[]> => {
    const files = await readSchemaDump(app.root);
    return checkSchemaDump(app.root, {}, async () => ({
      catalog: emptyCatalog(),
      files,
      reload: [],
    }));
  };

  const ledgerAudit = async (row: LedgerRow): Promise<string | undefined> => {
    try {
      auditLedger([row], await readMigrations(app.root), 'dev');
      return undefined;
    } catch (error) {
      return (error as { fix: string }).fix;
    }
  };

  test(
    'X_MIGRATION_CONFLICT restores the file, and the ledger agrees again',
    async () => {
      const row = {
        id: ID,
        name: 'truth',
        checksum: checksumOf(PRISTINE),
        app_version: 'dev',
      } as LedgerRow;
      const clean = (await readMigrations(app.root))[0];
      const applied = { ...row, checksum: checksumOf(clean?.up ?? '') };
      expect(await ledgerAudit(applied)).toBeUndefined();
      // Committed, which is what `git checkout -- <file>` could not undo: HEAD is the edit.
      await write(SQL, 'create table truth (id text, hacked text);\n');
      await app.sh(`${GIT} commit -qam edit`);
      const fix = (await ledgerAudit(applied)) ?? '';
      const listed = await app.sh(fix);
      expect(listed.code).toBe(0);
      // As the line says: each listed revision, until the ledger's checksum agrees.
      const restore = /git checkout <rev> -- (\S+)/.exec(fix)?.[1] ?? '';
      let agreed = false;
      for (const rev of listed.stdout.split('\n').map((line) => line.split(' ')[0] ?? '')) {
        if (rev === '' || agreed) continue;
        await app.sh(`git checkout -q ${rev} -- ${restore}`);
        agreed = (await ledgerAudit(applied)) === undefined;
      }
      expect(agreed).toBe(true);
    },
    ROW_MS,
  );

  test(
    'the poisoned dump is red at drift until restored, and the printed line restores it',
    async () => {
      // What `x db gen "fix initial"` did, exit 0: the edit is in the migration AND in the dump.
      await write(SQL, 'create table truth (id text, hacked text);\n');
      await write(`${SCHEMA_DUMP_DIR}/04_tables/truth.sql`, COLUMN_DUMP(['id', 'hacked']));
      const [finding] = await drift();
      expect(finding?.code).toBe('X_DB_DRIFT');
      expect(finding?.cause).toContain('"hacked"');
      expect((await app.sh(finding?.fix ?? '')).code).toBe(0);
      expect(await drift()).toEqual([]);
    },
    ROW_MS,
  );
});
