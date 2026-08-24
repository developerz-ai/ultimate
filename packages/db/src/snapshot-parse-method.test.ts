// The access method across the sidecar boundary. `snapshot-json.test.ts` proves a whole snapshot
// round-trips; this file is about the one field that may be ABSENT, because every sidecar written
// before it existed is — and reading those as anything but a btree is drift on a correct database.

import { describe, expect, test } from 'bun:test';
import { indexMethodOf } from './index-method';
import { parseSnapshot } from './snapshot-parse';

const sidecar = (index: Record<string, unknown>): unknown => ({
  tables: [
    {
      schema: 'public',
      name: 'posts',
      primaryKey: ['id'],
      columns: [{ name: 'tags', dataType: 'jsonb', nullable: true, default: null, position: 1 }],
      indexes: [
        { name: 'posts_tags_idx', columns: ['tags'], unique: false, primary: false, ...index },
      ],
      foreignKeys: [],
    },
  ],
});

const indexOf = (value: unknown) => parseSnapshot(value)?.tables[0]?.indexes[0];

describe('parseSnapshot · using', () => {
  test('a declared method round-trips', () => {
    expect(indexOf(sidecar({ where: null, order: null, using: 'gin' }))?.using).toBe('gin');
  });

  test('a sidecar written before the field existed keeps its btree reading', () => {
    const parsed = indexOf(sidecar({ where: null, order: null }));
    expect(parsed).not.toHaveProperty('using');
    expect(indexMethodOf(parsed ?? {})).toBe('btree');
  });

  test('a method the closed set does not carry is still read, not discarded', () => {
    // The refusal belongs at generation (`declaredMethod`), where the fix names the field. Here it
    // would throw the WHOLE snapshot away, and `x db gen` would then diff against nothing and emit
    // `create table` for every table the database already holds.
    expect(indexOf(sidecar({ where: null, order: null, using: 'gist' }))?.using).toBe('gist');
  });

  test('a method that is not a string rejects the snapshot, rather than being cast', () => {
    expect(parseSnapshot(sidecar({ where: null, order: null, using: 7 }))).toBeUndefined();
    expect(parseSnapshot(sidecar({ where: null, order: null, using: null }))).toBeUndefined();
  });
});
