// Single responsibility: a declared index method against the one the catalog holds. This is the
// half that makes `using` real — an emitter that can write `using gin` while drift cannot see the
// method ships a btree for a declared GIN index and nothing anywhere says so.

import { describe, expect, test } from 'bun:test';
import { diffSchema } from './drift';
import type { IndexDescription, SchemaDescription, TableDescription } from './introspect';

const table = (index: Partial<IndexDescription>): TableDescription => ({
  schema: 'public',
  name: 'posts',
  columns: [{ name: 'tags', dataType: 'jsonb', nullable: true, default: null, position: 1 }],
  primaryKey: [],
  indexes: [
    {
      name: 'posts_tags_idx',
      columns: ['tags'],
      unique: false,
      primary: false,
      where: null,
      order: null,
      ...index,
    },
  ],
  foreignKeys: [],
});

const schema = (index: Partial<IndexDescription>): SchemaDescription => ({
  tables: [table(index)],
});

describe('the index method is compared', () => {
  test('a declared GIN index against a live btree is a difference, not silence', () => {
    const report = diffSchema(schema({ using: 'btree' }), schema({ using: 'gin' }));

    expect(report.ok).toBe(false);
    expect(report.differences).toEqual([
      {
        kind: 'changed-index',
        table: 'posts',
        column: null,
        cause: 'index "posts_tags_idx" on "posts" is a btree index, not what migrations declare',
        fix: 'x db migrate',
      },
    ]);
  });

  test('the reverse is a difference too — a live GIN nobody declared is still wrong', () => {
    const report = diffSchema(schema({ using: 'gin' }), schema({ using: 'btree' }));

    expect(report.ok).toBe(false);
    expect(report.differences[0]?.cause).toContain('is a gin index');
  });

  test('an access method the closed set does not carry is reported by the name the catalog gave', () => {
    const report = diffSchema(schema({ using: 'gist' }), schema({ using: 'gin' }));

    expect(report.differences[0]?.cause).toContain('is a gist index');
  });

  test('two btrees agree, however each side spelled the default', () => {
    // A snapshot written before `using` existed carries no method at all, and every index it
    // recorded WAS a btree — so an old sidecar may not read as drift against a correct database.
    expect(diffSchema(schema({ using: 'btree' }), schema({})).ok).toBe(true);
    expect(diffSchema(schema({}), schema({ using: 'btree' })).ok).toBe(true);
    expect(diffSchema(schema({}), schema({})).ok).toBe(true);
  });

  test('two GIN indexes agree', () => {
    expect(diffSchema(schema({ using: 'gin' }), schema({ using: 'gin' })).ok).toBe(true);
  });
});
