// The newest migration's sidecar, against what the whole migration CHAIN's SQL leaves behind.
// Every assertion below reads the SQL text and never the entity declarations — asserting the
// sidecar against `snapshotOf(describeEntities())` would derive both sides from one source and
// could not fail.
//
// Two failures it exists against. The first is ABSENCE: with no sidecar on the newest migration,
// `x db gen` answers X_MIGRATION_SNAPSHOT_MISSING and refuses to run at all, `x db migrate`
// reports `unknown-schema` drift, and `x verify`'s snapshot half declines to compare. Still live,
// and it is now the newest migration that has to carry one — whichever that becomes.
//
// The second is a LIE, and it INVERTED on 2026-08-25 without going away. It used to be that the
// newest sidecar was hand-written and recording the entities would have erased real differences.
// The newest sidecar is now `x db gen`'s own, so it agrees with the entities BY CONSTRUCTION —
// which moves the whole question onto the SQL: `declaredSchema` reads this one file and calls it
// the database, so anything the chain's statements leave on a real database and this file omits
// is invisible to the next generation. Three such objects exist and are pinned by name below.
//
// No framework import on purpose. `@postly/db` depends on `@ultimat3/entity` and not on
// `@ultimat3/db`, and the question here is whether files on disk agree — text against JSON.

import { join } from 'node:path';
import { beforeAll, describe, expect, test } from '@ultimat3/testing';

const MIGRATIONS = join(import.meta.dir, 'migrations');

/** Only the `up` half. The marker is a whole line — 0001's own header mentions `-- down`. */
const DOWN = /^[ \t]*--[ \t]*down[ \t]*$/m;

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
}
interface RecordedCheck {
  readonly name: string;
  readonly expression: string;
}
interface RecordedTable {
  readonly name: string;
  readonly columns: readonly RecordedColumn[];
  readonly indexes: readonly RecordedIndex[];
  readonly checks: readonly RecordedCheck[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStrings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((each) => typeof each === 'string');

function narrowIndex(value: unknown): RecordedIndex | undefined {
  if (!isRecord(value)) return undefined;
  const { name, columns, unique } = value;
  if (typeof name !== 'string' || !isStrings(columns) || typeof unique !== 'boolean') return;
  return { name, columns, unique };
}

function narrowCheck(value: unknown): RecordedCheck | undefined {
  if (!isRecord(value)) return undefined;
  const { name, expression } = value;
  if (typeof name !== 'string' || typeof expression !== 'string') return undefined;
  return { name, expression };
}

function narrowColumn(value: unknown): RecordedColumn | undefined {
  if (!isRecord(value)) return undefined;
  const { name, dataType, nullable, default: fallback } = value;
  if (typeof name !== 'string' || typeof dataType !== 'string') return undefined;
  if (typeof nullable !== 'boolean') return undefined;
  if (!(fallback === null || typeof fallback === 'string')) return undefined;
  return { name, dataType, nullable, default: fallback };
}

/** `undefined` from any member drops the whole list — a partly-read table is not a smaller one. */
function narrowAll<T>(value: unknown, one: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: T[] = [];
  for (const item of value) {
    const each = one(item);
    if (each === undefined) return undefined;
    out.push(each);
  }
  return out;
}

/**
 * Narrowed, never asserted: `{"tables":[null]}` is valid JSON, and a sidecar that does not carry
 * this shape is the same defect as one that is missing — `@ultimat3/db`'s `parseSnapshot` refuses
 * it for the same reason, one layer down, and a cast here would let a malformed one read as an
 * empty schema that every assertion below passes over. `checks` is absent rather than `[]` on a
 * table declaring none, exactly as `snapshotOf` writes it.
 */
function tablesOf(value: unknown): readonly RecordedTable[] {
  const tables = isRecord(value) ? value['tables'] : undefined;
  if (!Array.isArray(tables)) return [];
  const out: RecordedTable[] = [];
  for (const table of tables) {
    if (!isRecord(table) || typeof table['name'] !== 'string') continue;
    const columns = narrowAll(table['columns'], narrowColumn);
    const indexes = narrowAll(table['indexes'], narrowIndex);
    const raw = table['checks'];
    const checks = raw === undefined ? [] : narrowAll(raw, narrowCheck);
    if (columns === undefined || indexes === undefined || checks === undefined) continue;
    out.push({ name: table['name'], columns, indexes, checks });
  }
  return out;
}

/** A line comment ends at the newline; a `--` inside a quoted regex literal does not start one. */
function stripComments(sql: string): string {
  let out = '';
  let quoted = false;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i] ?? '';
    if (quoted) {
      out += char;
      if (char === "'") quoted = false;
      continue;
    }
    if (char === "'") {
      quoted = true;
      out += char;
      continue;
    }
    if (char === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    out += char;
  }
  return out;
}

interface LiveIndex {
  readonly table: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
}
interface AddedColumn {
  readonly table: string;
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly fallback: string | null;
}

/**
 * What the chain's `up` statements leave behind, walked IN ORDER. Order is the whole point: the
 * newest migration drops `orgs_slug_check` and re-adds it two statements later, and a set built by
 * counting matches rather than replaying them would call that constraint gone.
 */
interface ChainState {
  readonly tables: ReadonlySet<string>;
  readonly indexes: ReadonlyMap<string, LiveIndex>;
  readonly checks: ReadonlyMap<string, string>;
  readonly added: readonly AddedColumn[];
}

const unquote = (value: string): string => value.replace(/"/g, '').trim();
const columnList = (value: string): string[] =>
  value.split(',').map((column) =>
    unquote(column)
      .replace(/\s+(asc|desc)$/i, '')
      .trim(),
  );

function walk(statements: readonly string[]): ChainState {
  const tables = new Set<string>();
  const indexes = new Map<string, LiveIndex>();
  const checks = new Map<string, string>();
  const added: AddedColumn[] = [];
  for (const statement of statements) {
    const created = statement.match(/^create table "?(\w+)"? \(([\s\S]*)\)$/i);
    if (created !== null) {
      const table = created[1] ?? '';
      const body = created[2] ?? '';
      tables.add(table);
      for (const one of body.matchAll(/CONSTRAINT "?(\w+)"? UNIQUE \(([^)]*)\)/gi))
        indexes.set(one[1] ?? '', { table, columns: columnList(one[2] ?? ''), unique: true });
      for (const one of body.matchAll(/CONSTRAINT "?(\w+)"? CHECK \(/gi))
        checks.set(one[1] ?? '', table);
      continue;
    }
    const dropped = statement.match(/^drop table (?:if exists )?"?(\w+)"?/i);
    if (dropped !== null) {
      tables.delete(dropped[1] ?? '');
      continue;
    }
    const index = statement.match(/^create (unique )?index "?(\w+)"? on "?(\w+)"? ?\(([^)]*)\)/i);
    if (index !== null) {
      indexes.set(index[2] ?? '', {
        table: index[3] ?? '',
        columns: columnList(index[4] ?? ''),
        unique: index[1] !== undefined,
      });
      continue;
    }
    const unindex = statement.match(/^drop index (?:if exists )?"?(\w+)"?/i);
    if (unindex !== null) {
      indexes.delete(unindex[1] ?? '');
      continue;
    }
    const constraint = statement.match(/^alter table "?(\w+)"? add constraint "?(\w+)"? check\b/i);
    if (constraint !== null) {
      checks.set(constraint[2] ?? '', constraint[1] ?? '');
      continue;
    }
    const unconstraint = statement.match(
      /^alter table "?\w+"? drop constraint (?:if exists )?"?(\w+)"?/i,
    );
    if (unconstraint !== null) {
      indexes.delete(unconstraint[1] ?? '');
      checks.delete(unconstraint[1] ?? '');
      continue;
    }
    const column = statement.match(/^alter table "?(\w+)"? add column "?(\w+)"? (.*)$/i);
    if (column !== null) {
      // Everything before an inline column CHECK is the type and its modifiers; the predicate
      // itself says `is null`, which a nullability test run over the whole tail would misread.
      const rest = (column[3] ?? '').split(/\s+check\s*\(/i)[0] ?? '';
      const fallback = rest.match(/\bdefault\s+(\S+)/i);
      added.push({
        table: column[1] ?? '',
        name: column[2] ?? '',
        dataType: (rest.split(/\s+(?:not null|null|default)\b/i)[0] ?? '').trim(),
        nullable: !/\bnot null\b/i.test(rest),
        fallback: fallback === null ? null : (fallback[1] ?? ''),
      });
    }
  }
  return { tables, indexes, checks, added };
}

/**
 * Objects the chain's SQL creates, never drops, and the newest sidecar does not record — a
 * duplicate or a narrowing the generator emitted ALONGSIDE the 0001 original instead of in place
 * of it, so a real database carries both and `declaredSchema` knows about one.
 *
 * **Empty, and it earned the emptiness on 2026-08-26.** It held three: `member_unique_per_org`,
 * `members_tz_idx` and `post_slug_unique_per_org` — the last of which mattered most, because
 * `posts_post_slug_unique_key` is NARROWER, `(slug)` alone against 0001's `(org_id, slug)`. The
 * cause was `diffTable`'s index loop walking DECLARED indexes only: `checkPlan` and
 * `foreignKeyPlan` each answer "what does the record hold that the declaration does not" in both
 * directions and the index arm never did, so an index an entity stopped declaring stayed on the
 * database forever while the next sidecar quietly stopped recording it.
 * `packages/db/src/index-plan.ts` is the arm that closed it.
 *
 * Kept as a PIN rather than deleted: the assertion goes red in either direction, so a fourth
 * instance cannot land silently and neither can a regression that reintroduces the first three.
 */
const UNRECORDED_BY_THE_SIDECAR: readonly string[] = [];

let migrationFiles: readonly string[] = [];
let newest = '';
let sidecarExists = false;
let recorded: readonly RecordedTable[] = [];
let chain: ChainState = { tables: new Set(), indexes: new Map(), checks: new Map(), added: [] };
let ups: ReadonlyMap<string, string> = new Map();

const recordedIndexes = (): Map<string, LiveIndex> => {
  const out = new Map<string, LiveIndex>();
  for (const table of recorded)
    for (const index of table.indexes)
      out.set(index.name, { table: table.name, columns: index.columns, unique: index.unique });
  return out;
};

const missingFrom = (live: Iterable<string>, sidecar: ReadonlySet<string>): string[] =>
  [...live].filter((name) => !sidecar.has(name)).sort();

beforeAll(async () => {
  const files: string[] = [];
  for await (const file of new Bun.Glob('*.sql').scan({ cwd: MIGRATIONS })) files.push(file);
  // Derived, never listed: the newest migration is whichever `.sql` sorts last, which is the one
  // `declaredSchema` reads and the only one whose sidecar `x db gen` needs. A fourth migration
  // must move these assertions onto ITS sidecar rather than fail for having arrived.
  migrationFiles = files.sort();
  newest = migrationFiles[migrationFiles.length - 1] ?? '';
  const texts = new Map<string, string>();
  const statements: string[] = [];
  for (const file of migrationFiles) {
    const up = (await Bun.file(join(MIGRATIONS, file)).text()).split(DOWN)[0] ?? '';
    texts.set(file, up);
    for (const one of stripComments(up).split(';')) {
      const trimmed = one.trim().replace(/\s+/g, ' ');
      if (trimmed !== '') statements.push(trimmed);
    }
  }
  ups = texts;
  chain = walk(statements);
  const sidecar = Bun.file(join(MIGRATIONS, newest.replace(/\.sql$/, '.snapshot.json')));
  sidecarExists = await sidecar.exists();
  // An unreadable sidecar is an absent one, exactly as `readMigrations` treats it: the assertion
  // below reports the absence rather than the run dying in a hook with no verdict attached.
  recorded = sidecarExists ? tablesOf(await sidecar.json().catch(() => undefined)) : [];
});

describe('the newest migration records the schema this chain creates', () => {
  test('the newest migration carries a sidecar that parses — what x db gen refuses without', () => {
    expect(migrationFiles.length).toBeGreaterThan(1);
    expect(newest).toEndWith('.sql');
    expect(sidecarExists).toBe(true);
    // Non-empty AND as long as the chain's table set: `tablesOf` drops a table it cannot narrow,
    // so a sidecar with one malformed entry would otherwise read as a schema with one less table
    // and every set comparison below would call the difference real.
    expect(recorded).toHaveLength(chain.tables.size);
  });

  test('every table the chain creates is recorded, and nothing else is', () => {
    expect([...chain.tables].sort()).toEqual([
      'comments',
      'likes',
      'members',
      'orgs',
      'plans',
      'posts',
    ]);
    expect(recorded.map((table) => table.name).sort()).toEqual([...chain.tables].sort());
  });

  test('the sidecar records no index the chain does not leave behind', () => {
    // This direction has no pin and never will: an object recorded but never created is one the
    // next `x db gen` will not emit and no database will have — `42P07` on the generation after.
    expect(missingFrom(recordedIndexes().keys(), new Set(chain.indexes.keys()))).toEqual([]);
  });

  test('every index and UNIQUE the chain leaves behind is recorded, bar any pinned as unrecorded', () => {
    expect(chain.indexes.size).toBeGreaterThan(UNRECORDED_BY_THE_SIDECAR.length);
    expect(missingFrom(chain.indexes.keys(), new Set(recordedIndexes().keys()))).toEqual(
      [...UNRECORDED_BY_THE_SIDECAR].sort(),
    );
  });

  test('each one that IS recorded carries the table, columns and uniqueness the SQL gave it', () => {
    const sidecar = recordedIndexes();
    let compared = 0;
    for (const [name, live] of chain.indexes) {
      const found = sidecar.get(name);
      if (found === undefined) continue; // pinned by name in the test above; that list is now empty
      compared += 1;
      expect({ name, ...found }).toEqual({ name, ...live });
    }
    // The loop above skips on absence, so it would pass over an empty sidecar in silence.
    //
    // `walk` reads named `CONSTRAINT … UNIQUE (…)` clauses and not a bare `unique` on a column,
    // which `columnClause` can emit and `snapshotOf` records as `<table>_<column>_key`. The chain
    // holds none today (measured: zero across all three files). If one ever appears the miss is
    // LOUD, not silent — the sidecar would carry a name `chain.indexes` lacks, which is exactly
    // what "the sidecar records no index the chain does not leave behind" refuses. A parser for
    // column-level clauses is the fix if that day comes; a red run is the signal it has.
    expect(compared).toBe(chain.indexes.size - UNRECORDED_BY_THE_SIDECAR.length);
  });

  test('the CHECK constraints alive at the end of the chain are exactly what is recorded', () => {
    const sidecar = new Set(recorded.flatMap((table) => table.checks.map((check) => check.name)));
    expect(sidecar.size).toBeGreaterThan(0);
    // Both directions, no pin: the chain drops 0001's twelve by their old names and re-adds them
    // under the generator's, and either half of that swap going missing is a constraint a real
    // database enforces — or fails to — while nothing records it.
    expect(missingFrom(chain.checks.keys(), sidecar)).toEqual([]);
    expect(missingFrom(sidecar, new Set(chain.checks.keys()))).toEqual([]);
  });

  test('every column a later migration adds is recorded as that ALTER declares it', () => {
    // One today: `plans.monthly_scale`. NULL means "the currency's own minor unit", which is what
    // every existing row meant — a sidecar recording it NOT NULL would have the next generation
    // write a backfill nobody wants. Derived from the statement, so a second one is covered too.
    expect(chain.added.length).toBeGreaterThan(0);
    for (const column of chain.added) {
      const found = recorded
        .find((table) => table.name === column.table)
        ?.columns.find((each) => each.name === column.name);
      // `position` is deliberately not asserted: `snapshotOf` renumbers from the column NAME order,
      // so it says nothing about the migration and everything about the alphabet.
      expect({ at: `${column.table}.${column.name}`, ...found }).toEqual({
        at: `${column.table}.${column.name}`,
        name: column.name,
        dataType: column.dataType,
        nullable: column.nullable,
        default: column.fallback,
      });
    }
  });

  test('the ungeneratable statements are counted by the migration that holds them', () => {
    // The count is what keeps a squash honest: `x db gen` writes only what an entity declares, so
    // regenerating this directory discards every statement below in silence. No sidecar field
    // exists for either kind, which is why they are counted rather than recorded.
    const declaring = migrationFiles.filter((file) =>
      /^--\s*ungeneratable:/m.test(ups.get(file) ?? ''),
    );
    expect(declaring).toHaveLength(1);
    const declared = (ups.get(declaring[0] ?? '') ?? '').match(/^--\s*ungeneratable:\s*(\d+)/m);
    const whole = [...ups.values()].join('\n');
    const enums = [...whole.matchAll(/^CREATE TYPE (\w+) AS ENUM/gim)].map((one) => one[1] ?? '');
    const replicas = [...whole.matchAll(/^ALTER TABLE \w+ REPLICA IDENTITY FULL/gim)];
    expect(enums).toHaveLength(5);
    // Both ALTERs are still ON DISK and are no longer COUNTED. `x db gen` emits
    // `alter table … replica identity` as of 2026-08-26, from a live query's declared
    // `subscribes:`, so a squash no longer loses them and counting them would send an author to
    // hand-write SQL the generator writes. It was `enums.length + replicas.length` until then.
    expect(replicas).toHaveLength(2);
    expect(Number(declared?.[1])).toBe(enums.length);
    // And the sidecar cannot name one: a column on an enum type is recorded as the `text` the
    // generator would emit, which is a difference the chain's own ALTERs already performed.
    const types = recorded.flatMap((table) => table.columns.map((column) => column.dataType));
    expect(types.filter((type) => enums.includes(type))).toEqual([]);
  });
});
