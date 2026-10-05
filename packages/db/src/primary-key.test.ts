// The primary-key refusals hand the reader a command to paste, and every value in one is screened
// where it enters it (plan 101 row S12): a migration name rides into `x db gen "…"`, and a table
// name into SQL inside a `psql -c "…"` string, which is two languages deep.

import { describe, expect, test } from 'bun:test';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import { migrationNameArg, primaryKeyName } from './primary-key';

const column = (name: string, primaryKey = false): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: 'text',
  notNull: true,
  primaryKey,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
});

const posts = (key: readonly string[], columns = ['id', 'slug']): EntityDescriptionLike => ({
  name: 'Post',
  table: 'posts',
  primaryKey: key,
  columns: columns.map((name) => column(name, key.includes(name))),
  indexes: [],
});

const fixOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as { fix: string }).fix;
  }
  return expect.unreachable('the refusal did not fire');
};

describe('migrationNameArg', () => {
  test('an ordinary name is the double-quoted argument it always was', () => {
    expect(migrationNameArg('rekey posts')).toBe('"rekey posts"');
  });

  test('a quote and a semicolon stay inert inside the double quotes', () => {
    expect(migrationNameArg('say "hi"; rm -rf /')).toBe(String.raw`"say \"hi\"; rm -rf /"`);
  });

  // L3 of the sweep 1c audit: `x db gen "-rf"` is still a flag to the parser behind the quotes.
  test('a name opening with - is the placeholder, never an option', () => {
    expect(migrationNameArg('-rf')).toBe('"<a migration name>"');
    expect(migrationNameArg('--allow-destructive')).toBe('"<a migration name>"');
  });

  // CodeRabbit on #651: JSON writes a newline as `\\n`, which the shell passes on literally — the
  // pasted line would name a DIFFERENT migration. A control character is the placeholder.
  test('a control character in the name is the placeholder, not an escape', () => {
    for (const hostile of ['add\nposts', 'add\tposts', 'add\u007fposts', 'add\u0085posts']) {
      expect(migrationNameArg(hostile)).toBe('"<a migration name>"');
    }
  });

  test('a command substitution, a backtick or a history bang is never carried', () => {
    for (const hostile of ['re$(touch pwned)', 're`id`', 're!!']) {
      expect(migrationNameArg(hostile)).toBe('"<a migration name>"');
    }
  });

  test('the key-change refusal screens the name it echoes', () => {
    const fix = fixOf(() =>
      generateMigration({
        entities: [posts(['id', 'org_id'], ['id', 'slug', 'org_id'])],
        current: snapshotOf([posts(['id'])]),
        name: 'rekey $(touch pwned)',
        now: new Date('2026-10-02T00:00:00.000Z'),
      }),
    );
    expect(fix).not.toContain('$(');
    expect(fix).toStartWith('x db gen "<a migration name>"');
  });
});

// M2 of the sweep 1c audit: the text after `#` is a shell comment only up to the end of the line. A
// column or constraint name carrying a newline ended the comment, and the rest ran when pasted.
describe('names in the comment after the command', () => {
  // A column name cannot carry one — `identifier()` refuses whitespace — but an inbound foreign key's
  // name is read off the LIVE catalog, where `constraint "fk\n…"` is legal DDL.
  test('a newline in a live constraint name cannot end the comment', () => {
    const comments: EntityDescriptionLike = {
      name: 'Comment',
      table: 'comments',
      primaryKey: ['id'],
      columns: [column('id', true), { ...column('post_id'), references: 'posts.id' }],
      indexes: [],
    };
    const snapshot = snapshotOf([posts(['id']), comments]);
    const current = {
      ...snapshot,
      tables: snapshot.tables.map((table) => ({
        ...table,
        foreignKeys: table.foreignKeys.map((key) => ({ ...key, name: 'fk\nrm -rf ~' })),
      })),
    };
    const fix = fixOf(() =>
      generateMigration({
        entities: [posts(['slug']), comments],
        current,
        name: 'rekey',
        now: new Date('2026-10-02T00:00:00.000Z'),
      }),
    );
    expect(fix).not.toContain('\n');
    expect(fix).toContain(String.raw`fk\nrm -rf ~`);
  });
});

describe('primaryKeyName past the identifier limit', () => {
  test('an ordinary long table is looked up by name, as a SQL literal inside the shell string', () => {
    const table = 'a'.repeat(60);
    expect(fixOf(() => primaryKeyName(table))).toContain(`rel.relname = '${table}'`);
  });

  test('a table name carrying a quote, a semicolon or $(…) becomes the placeholder', () => {
    for (const suffix of ["';drop table x;--", '$(touch pwned)', '"x"']) {
      const fix = fixOf(() => primaryKeyName(`${'a'.repeat(60)}${suffix}`));
      expect(fix).not.toContain(suffix);
      expect(fix).toContain("rel.relname = '<table>'");
    }
  });
});
