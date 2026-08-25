// The migration sidecars, against the SQL they claim to describe. Two hand-written migrations
// predate `x db gen` in this app, so the `.snapshot.json` beside the newest one is hand-written
// too — and a hand-written record of a schema is worth exactly what checks it.
//
// Two failures it exists against. The first is ABSENCE: with no sidecar on the newest migration,
// `x db gen` answers X_MIGRATION_SNAPSHOT_MISSING and refuses to run at all, `x db migrate`
// reports `unknown-schema` drift, and `x verify`'s snapshot half declines to compare — which is
// where this app sat until 2026-08-25. The second is a LIE, and it is the one that would pass a
// looser test: a sidecar regenerated from the entities records what the app DECLARES rather than
// what these two files CREATE, every difference disappears, and the gate goes green over a
// database that has none of it. So every assertion below reads the SQL and never the entities.
//
// No framework import on purpose. `@postly/db` depends on `@ultimat3/entity` and not on
// `@ultimat3/db`, and the question here is whether two files on disk agree — text against JSON.

import { join } from 'node:path';
import { beforeAll, describe, expect, test } from '@ultimat3/testing';

const MIGRATIONS = join(import.meta.dir, 'migrations');

/** Only the `up` half. The marker is a whole line — 0001's own header mentions `-- down`. */
const DOWN = /^[ \t]*--[ \t]*down[ \t]*$/m;

const upOf = async (file: string): Promise<string> =>
  (await Bun.file(join(MIGRATIONS, file)).text()).split(DOWN)[0] ?? '';

/** What the sidecar records about one table, narrowed from JSON rather than asserted into shape. */
interface RecordedIndex {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
}
interface RecordedColumn {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly default: string | null;
  readonly position: number;
}
interface RecordedTable {
  readonly name: string;
  readonly columns: readonly RecordedColumn[];
  readonly indexes: readonly RecordedIndex[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Narrowed, never asserted: `{"tables":[null]}` is valid JSON, and a sidecar that does not carry
 * this shape is the same defect as one that is missing — `@ultimat3/db`'s `parseSnapshot` refuses
 * it for the same reason, one layer down, and a cast here would let a malformed one read as an
 * empty schema that every assertion below passes over.
 */
function tablesOf(value: unknown): readonly RecordedTable[] {
  const tables = isRecord(value) ? value['tables'] : undefined;
  if (!Array.isArray(tables)) return [];
  const out: RecordedTable[] = [];
  for (const table of tables) {
    if (!isRecord(table) || typeof table['name'] !== 'string') continue;
    const columns = table['columns'];
    const indexes = table['indexes'];
    if (!Array.isArray(columns) || !Array.isArray(indexes)) continue;
    out.push({
      name: table['name'],
      columns: columns as readonly RecordedColumn[],
      indexes: indexes as readonly RecordedIndex[],
    });
  }
  return out;
}

const INIT = '0001_init';
const NEWEST = '0002_money_scale';

let recorded: readonly RecordedTable[] = [];
let init = '';
let sidecarExists = false;
let migrationFiles: readonly string[] = [];

const tableNamed = (name: string): RecordedTable | undefined =>
  recorded.find((table) => table.name === name);

beforeAll(async () => {
  const files: string[] = [];
  for await (const file of new Bun.Glob('*.sql').scan({ cwd: MIGRATIONS })) files.push(file);
  migrationFiles = files.sort();
  init = await upOf(`${INIT}.sql`);
  const sidecar = Bun.file(join(MIGRATIONS, `${NEWEST}.snapshot.json`));
  sidecarExists = await sidecar.exists();
  // An unreadable sidecar is an absent one, exactly as `readMigrations` treats it: the assertion
  // below reports the absence rather than the run dying in a hook with no verdict attached.
  recorded = sidecarExists ? tablesOf(await sidecar.json().catch(() => undefined)) : [];
});

describe('the newest migration records the schema these files create', () => {
  test('the sidecar exists and parses — the condition x db gen refuses on', () => {
    // Derived, never listed: the newest migration is whichever `.sql` sorts last, which is the
    // one `declaredSchema` reads and the only one whose sidecar `x db gen` needs.
    expect(migrationFiles).toEqual([`${INIT}.sql`, `${NEWEST}.sql`]);
    expect(sidecarExists).toBe(true);
    expect(recorded).not.toHaveLength(0);
  });

  test('every table 0001 creates is recorded, and nothing else is', () => {
    // `?? ''` on every capture in this file: a group that matched is a `string | undefined` to
    // the compiler, and an empty name fails the assertion below rather than silently widening it.
    const created = [...init.matchAll(/CREATE TABLE (\w+) \(/g)]
      .map((match) => match[1] ?? '')
      .sort();
    expect(created).toEqual(['comments', 'likes', 'members', 'orgs', 'plans', 'posts']);
    expect(recorded.map((table) => table.name).sort()).toEqual(created);
  });

  test('every UNIQUE constraint is recorded under the name and columns 0001 gave it', () => {
    const constraints = [...init.matchAll(/CONSTRAINT (\w+) UNIQUE \(([^)]*)\)/g)];
    // Three: orgs_slug_key, member_unique_per_org, post_slug_unique_per_org. A sidecar derived
    // from the entities carries none of these names — it carries `posts_post_slug_unique_key`
    // over ("slug") alone, which is the app's DECLARED uniqueness and not this database's.
    expect(constraints).toHaveLength(3);
    for (const [, name, columns] of constraints) {
      const expected = (columns ?? '').split(',').map((column) => column.trim());
      const index = recorded
        .flatMap((table) => table.indexes)
        .find((candidate) => candidate.name === name);
      expect({ name, columns: index?.columns, unique: index?.unique }).toEqual({
        name,
        columns: expected,
        unique: true,
      });
    }
  });

  test('every index 0001 creates is recorded under its own name', () => {
    const created = [...init.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+) ON (\w+)/g)];
    expect(created).toHaveLength(7);
    for (const [, name, table] of created) {
      expect(tableNamed(table ?? '')?.indexes.map((index) => index.name)).toContain(name);
    }
  });

  test('the column 0002 adds is recorded, nullable, as that migration argues', () => {
    // NULL means "the currency's own minor unit", which is what every existing row meant — so a
    // sidecar recording it NOT NULL would have the next generation write a backfill nobody wants.
    const column = tableNamed('plans')?.columns.find((each) => each.name === 'monthly_scale');
    // `position` is deliberately not asserted: `snapshotOf` renumbers from the column NAME order,
    // so it says nothing about this migration and everything about the alphabet.
    expect(column?.dataType).toBe('integer');
    expect(column?.nullable).toBe(true);
    expect(column?.default).toBeNull();
  });
});
