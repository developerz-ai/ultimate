// Which recorded objects a retype breaks, and which it must leave alone. The two errors are not
// symmetrical, so both directions are pinned here: a dependent MISSED is `42883` inside
// `ROLE=migrate` (`generate-retype.live.test.ts` is where that is measured against a server), and
// a dependent INVENTED is an index rebuild and a validating table scan nobody asked for.

import { describe, expect, test } from 'bun:test';
import type { IndexDescription, TableDescription } from './introspect';
import { moveDependentsAside, referencesColumn, retypeDependents } from './retype-dependents';

const index = (
  name: string,
  columns: readonly string[],
  where: string | null,
  overrides: Partial<IndexDescription> = {},
): IndexDescription => ({
  name,
  columns,
  unique: false,
  primary: false,
  where,
  order: null,
  ...overrides,
});

const table = (overrides: Partial<TableDescription> = {}): TableDescription => ({
  schema: 'public',
  name: 'posts',
  columns: [
    { name: 'id', dataType: 'uuid', nullable: false, default: null, position: 1 },
    { name: 'status', dataType: 'post_status', nullable: false, default: null, position: 2 },
    { name: 'org_id', dataType: 'uuid', nullable: false, default: null, position: 3 },
  ],
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [],
  ...overrides,
});

describe('referencesColumn', () => {
  test('a bare reference is one, whatever it is next to', () => {
    expect(referencesColumn("status = 'published'", 'status')).toBe(true);
    expect(referencesColumn('(status is null)', 'status')).toBe(true);
    expect(referencesColumn("posts.status <> 'draft'", 'status')).toBe(true);
  });

  test('an unquoted identifier is folded, because Postgres folds it', () => {
    // `WHERE STATUS = 'x'` names the column `status`, and reading it as a different one is the
    // miss that ends in 42883.
    expect(referencesColumn("STATUS = 'published'", 'status')).toBe(true);
  });

  test('the fold is applied to the COLUMN too, so a capitalised physical name still matches', () => {
    // `.column('Status')` is a legal physical name and every DDL that names it quotes it. Folding
    // only the text and not the column being asked about answers `false` for a real dependent.
    expect(referencesColumn('"Status" is null', 'Status')).toBe(true);
    expect(referencesColumn('Status is null', 'Status')).toBe(true);
  });

  test('a QUOTED identifier is a reference, not noise', () => {
    // The dangerous direction: `sql-scan.ts` calls a quoted identifier a noise span, so a scan
    // that skipped every span alike would read `"status"` as data and miss the dependent.
    expect(referencesColumn(`"status" = 'published'`, 'status')).toBe(true);
  });

  test('a name that only appears inside a literal or a comment is not a reference', () => {
    expect(referencesColumn("kind = 'status'", 'status')).toBe(false);
    expect(referencesColumn('id > 0 -- status', 'status')).toBe(false);
    expect(referencesColumn('id > 0 /* status */', 'status')).toBe(false);
    expect(referencesColumn('$tag$ status $tag$ = body', 'status')).toBe(false);
  });

  test('a longer name that merely contains the column is not a reference', () => {
    expect(referencesColumn("status_code = 'x'", 'status')).toBe(false);
    expect(referencesColumn("old_status = 'x'", 'status')).toBe(false);
  });
});

describe('retypeDependents', () => {
  test('a partial index whose predicate reads the column is dependent', () => {
    const dependents = retypeDependents(
      'status',
      table({ indexes: [index('posts_feed_idx', ['org_id'], "status = 'published'")] }),
    );
    expect(dependents.indexes.map((each) => each.name)).toEqual(['posts_feed_idx']);
  });

  test('a plain btree over the column is NOT — Postgres rebuilds that one itself', () => {
    // Measured on 18.4: the ALTER succeeds with a btree, a composite btree and a unique index over
    // the retyped column in place. Dropping them would be a rebuild per index for nothing.
    const dependents = retypeDependents(
      'status',
      table({
        indexes: [
          index('posts_status_idx', ['status'], null),
          index('posts_org_status_idx', ['org_id', 'status'], null),
          index('posts_status_key', ['status'], null, { unique: true }),
        ],
      }),
    );
    expect(dependents.indexes).toEqual([]);
  });

  test('a PRIMARY index is never dependent, whatever a hand-edited sidecar records', () => {
    // Postgres has no partial primary key, so this pairing cannot come out of a catalog — but a
    // `.snapshot.json` is a file anything may edit, and `drop index` on a primary key's index is
    // `2BP01 cannot drop index … because constraint … requires it`, which the restore cannot undo.
    const dependents = retypeDependents(
      'status',
      table({ indexes: [index('posts_pkey', ['id'], "status = 'published'", { primary: true })] }),
    );
    expect(dependents.indexes).toEqual([]);
  });

  test('a partial index whose predicate reads ANOTHER column is not dependent', () => {
    const dependents = retypeDependents(
      'status',
      table({ indexes: [index('posts_org_idx', ['org_id'], 'org_id is not null')] }),
    );
    expect(dependents.indexes).toEqual([]);
  });

  test('a CHECK whose expression reads the column is dependent, and one that does not is not', () => {
    const dependents = retypeDependents(
      'status',
      table({
        checks: [
          { name: 'posts_publish_coherent_check', expression: "(status = 'published') = (id > 0)" },
          { name: 'posts_org_check', expression: 'org_id is not null' },
        ],
      }),
    );
    expect(dependents.checks.map((each) => each.name)).toEqual(['posts_publish_coherent_check']);
  });

  test('a table recording no checks at all yields none — absent is not empty and never throws', () => {
    expect(retypeDependents('status', table()).checks).toEqual([]);
  });
});

describe('moveDependentsAside', () => {
  test('the drop goes in up BEFORE the caller pushes its ALTER, and the restore in down', () => {
    const plan = { up: [] as string[], down: [] as string[] };
    const moved = { indexes: new Set<string>(), checks: new Set<string>() };
    moveDependentsAside(
      table({
        indexes: [index('posts_feed_idx', ['org_id'], "status = 'published'", { order: 'desc' })],
        checks: [{ name: 'posts_coherent_check', expression: "status <> 'x'" }],
      }),
      'status',
      plan,
      moved,
    );
    expect(plan.up).toEqual([
      'drop index "posts_feed_idx";',
      'alter table "posts" drop constraint "posts_coherent_check";',
    ]);
    // Pushed forwards, read backwards — `down` is reversed as a whole at assembly, so the retype's
    // own reversal (pushed after these) runs FIRST and the predicates go back onto the old type.
    expect(plan.down).toEqual([
      `create index "posts_feed_idx" on "posts" ("org_id" desc) where (status = 'published');`,
      `alter table "posts" add constraint "posts_coherent_check" check (status <> 'x');`,
    ]);
    expect([...moved.indexes, ...moved.checks]).toEqual(['posts_feed_idx', 'posts_coherent_check']);
  });

  test('nothing dependent means nothing pushed — a retype pays for this rule only when it must', () => {
    const plan = { up: [] as string[], down: [] as string[] };
    const moved = { indexes: new Set<string>(), checks: new Set<string>() };
    moveDependentsAside(
      table({ indexes: [index('posts_status_idx', ['status'], null)] }),
      'status',
      plan,
      moved,
    );
    expect(plan.up).toEqual([]);
    expect(plan.down).toEqual([]);
  });
});
