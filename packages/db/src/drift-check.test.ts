// A CHECK a migration declares, against the ones the catalog holds — by NAME, and never by
// expression. `pg_get_constraintdef` answers Postgres' own rewriting of the predicate
// (`status in ('draft','published')` comes back as `CHECK ((status = ANY (ARRAY['draft'::text,
// 'published'::text])))`), so a comparison of texts reports drift on a correct database forever.
// That is the reason `TableDescription.checks` carries no catalog value at all and
// `TableDescription.checkNames` is a separate field: one is a declaration, the other is a catalog
// read, and a field that meant both would put a rewritten expression where `checkPlan` expects a
// generated spelling.

import { describe, expect, test } from 'bun:test';
import { diffSchema } from './drift';
import type { SchemaDescription, TableDescription } from './introspect';

const posts = (overrides: Partial<TableDescription> = {}): TableDescription => ({
  schema: 'public',
  name: 'posts',
  columns: [{ name: 'status', dataType: 'text', nullable: false, default: null, position: 1 }],
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [],
  ...overrides,
});

const schema = (...tables: readonly TableDescription[]): SchemaDescription => ({ tables });

const DECLARED = { name: 'posts_status_check', expression: "status in ('draft', 'published')" };

describe('a CHECK migrations declare, against the ones the catalog holds', () => {
  test('a constraint dropped out from under the declaration is drift', () => {
    // The failure this exists for: `alter table posts drop constraint posts_status_check` in a
    // psql session, and every later write accepted whatever the app did not stop.
    const report = diffSchema(
      schema(posts({ checkNames: [] })),
      schema(posts({ checks: [DECLARED] })),
    );
    expect(report.ok).toBe(false);
    expect(report.differences[0]?.kind).toBe('missing-check');
    expect(report.differences[0]?.cause).toBe(
      'table "posts" is missing check constraint "posts_status_check" that migrations declare',
    );
    // The declared side carries the predicate, so the repair is the statement itself: the
    // migration that declares this constraint is already in the ledger, so running the migrator
    // alone applies nothing — it is the migration the reader writes that it then applies.
    expect(report.differences[0]?.fix).toBe(
      `alter table "posts" add constraint "posts_status_check" ` +
        `check (status in ('draft', 'published'));   # in a new migration, then x db migrate`,
    );
  });

  /**
   * Both identifiers in that statement are the catalog's and the sidecar's, and a `.snapshot.json`
   * is a file on disk anything may edit. A constraint name that closes its own quote appends a
   * second statement to the line a reader pastes into a migration — the same hole
   * `unexpected-table`'s drop carried, one constructor over.
   *
   * The EXPRESSION is deliberately still spliced: it is a predicate, not an identifier, there is
   * no screen that could accept `status in (...)` and reject a second statement, and it is the
   * declared side's own text — the author's, out of their own migration. That is a narrower claim
   * than "this line is safe", and it is the honest one.
   */
  test('a constraint name that closes its own quote cannot append a statement to the fix', () => {
    const hostile = {
      name: 'posts_status_check"; drop table users; --',
      expression: "status <> ''",
    };
    const report = diffSchema(
      schema(posts({ checkNames: [] })),
      schema(posts({ checks: [hostile] })),
    );
    const difference = report.differences[0];

    expect(difference?.kind).toBe('missing-check');
    expect(difference?.fix).not.toContain('drop table users');
    expect(difference?.fix).not.toContain(hostile.name);
    // Reported, and the name is still readable where nobody pastes it.
    expect(difference?.cause).toContain(hostile.name);
  });

  test('a correct database is SILENT, however Postgres has rewritten the predicate', () => {
    // The harder half. The catalog's spelling of this exact constraint is
    // `CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text])))`; nothing here reads it,
    // and the day it does, this is the test that goes red.
    const live = posts({ checkNames: ['posts_status_check'] });
    expect(diffSchema(schema(live), schema(posts({ checks: [DECLARED] }))).ok).toBe(true);
  });

  test('a constraint the catalog holds and no migration declares is not drift', () => {
    // Only the declared side is judged, the rule `compareIndexes` and `compareForeignKeys` state:
    // a NOT NULL, an `enumerated()` column's old anonymous form and every constraint an extension
    // brought would each be a finding against a database that is exactly right.
    const live = posts({ checkNames: ['posts_status_check', 'posts_legacy_check'] });
    expect(diffSchema(schema(live), schema(posts({ checks: [DECLARED] }))).ok).toBe(true);
  });

  test('a sidecar that records no checks reports none, against a database FULL of them', () => {
    // Every app generated before `checks` existed is this shape on its first run: the sidecar is
    // silent and the database holds every constraint the migrations created. Silent both ways —
    // an absent `checks` declares nothing, and a live name is judged by nobody.
    const live = posts({ checkNames: ['posts_status_check', 'posts_legacy_check'] });
    expect(diffSchema(schema(live), schema(posts())).ok).toBe(true);
  });

  test('a live description that never READ the catalog reports none, and says so by absence', () => {
    // `introspect()` always answers with the field, `[]` included, so absent can only mean the
    // description came from somewhere that did not ask. Reading that as "the database holds none"
    // is a finding per declared constraint against a database nobody has looked at.
    expect(diffSchema(schema(posts()), schema(posts({ checks: [DECLARED] }))).ok).toBe(true);
  });
});
