// The four index key parts through `x db gen` and back: emitted, recorded in the sidecar, parsed
// from its bytes, and — the point — a second generation over that sidecar writes nothing. A part
// the snapshot dropped would rebuild its index on every run.

import { describe, expect, test } from 'bun:test';
import type {
  ColumnDescriptionLike,
  EntityDescriptionLike,
  IndexDescriptionLike,
} from './entity-shape';
import { generateMigration } from './generate';
import type { SchemaDescription } from './introspect';
import { snapshotJson } from './snapshot-json';
import { parseSnapshot } from './snapshot-parse';

const column = (name: string, kind = 'text'): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind,
  notNull: name === 'id',
  primaryKey: name === 'id',
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
});

const plain = { unique: false, where: null, order: null } as const;
const PARTS: readonly IndexDescriptionLike[] = [
  {
    ...plain,
    name: 'users_email_lower',
    columns: ['email'],
    unique: true,
    expression: 'lower(email)',
  },
  { ...plain, name: 'users_feed', columns: ['email', 'name'], orders: [null, 'desc'] },
  { ...plain, name: 'users_cover', columns: ['email'], include: ['name'] },
  {
    ...plain,
    name: 'users_name_trgm',
    columns: ['name'],
    using: 'gin',
    operatorClass: 'gin_trgm_ops',
  },
];

const users = (indexes: readonly IndexDescriptionLike[]): EntityDescriptionLike => ({
  name: 'User',
  table: 'users',
  primaryKey: ['id'],
  columns: [column('id', 'uuid'), column('email'), column('name')],
  indexes,
});

const at = new Date('2026-11-12T12:00:00.000Z');

/** What `x db gen` reads back: the sidecar's BYTES, parsed — never the object it wrote. */
const reread = (snapshot: SchemaDescription): SchemaDescription => {
  const parsed = parseSnapshot(JSON.parse(snapshotJson(snapshot)));
  if (parsed === undefined) expect.unreachable('the sidecar this generator wrote did not parse');
  return parsed;
};

/**
 * The newest sidecar a generation writes: an index on an existing table may be built in a
 * non-transactional follow-up step (`concurrent-index.ts`), whose snapshot is the one `x db gen` reads next.
 */
const newest = (migration: ReturnType<typeof gen>): SchemaDescription =>
  reread(migration.followUp?.snapshot ?? migration.snapshot);

const gen = (indexes: readonly IndexDescriptionLike[], current?: SchemaDescription) =>
  generateMigration({
    entities: [users(indexes)],
    name: 'users',
    now: at,
    ...(current === undefined ? {} : { current }),
  });

describe('x db gen · index key parts round-trip', () => {
  test('each part is emitted, with pg_trgm created before the trigram index', () => {
    const { up } = gen(PARTS);
    expect(up).toContain('((lower(email)))');
    expect(up).toContain('("email", "name" desc)');
    expect(up).toContain('include ("name")');
    expect(up).toContain('("name" gin_trgm_ops)');
    const extension = 'create extension if not exists "pg_trgm";';
    expect(up).toContain(extension);
    expect(up.indexOf(extension)).toBeLessThan(up.indexOf('gin_trgm_ops'));
  });

  test('the sidecar records every part, and the second generation over it is empty', () => {
    const first = gen(PARTS);
    const recorded = reread(first.snapshot);
    const indexes = recorded.tables[0]?.indexes ?? [];
    expect(indexes.find((i) => i.name === 'users_email_lower')?.expression).toBe('lower(email)');
    expect(indexes.find((i) => i.name === 'users_feed')?.orders).toEqual([null, 'desc']);
    expect(indexes.find((i) => i.name === 'users_cover')?.include).toEqual(['name']);
    expect(indexes.find((i) => i.name === 'users_name_trgm')?.operatorClass).toBe('gin_trgm_ops');
    expect(gen(PARTS, recorded).up.trim()).toBe('');
  });

  test('added to an existing table, each part is built once and then is silence', () => {
    const before = newest(gen([]));
    const added = gen(PARTS, before);
    expect(added.up).toContain('create extension if not exists "pg_trgm";');
    const second = gen(PARTS, newest(added));
    expect(second.up.trim()).toBe('');
    expect(second.followUp).toBeUndefined();
  });

  test('changing one part is a rebuild of that index alone', () => {
    const recorded = newest(gen(PARTS));
    const moved = PARTS.map((index) =>
      index.name === 'users_cover' ? { ...index, include: ['id'] } : index,
    );
    const rebuilt = gen(moved, recorded);
    const up = `${rebuilt.up}\n${rebuilt.followUp?.up ?? ''}`;
    expect(up).toContain('include ("id")');
    expect(up).not.toContain('users_feed');
    expect(up).not.toContain('create extension');
  });

  test('an index declaring none of the parts records none of their keys', () => {
    const recorded = reread(gen([{ ...plain, name: 'users_email', columns: ['email'] }]).snapshot);
    expect(Object.keys(recorded.tables[0]?.indexes[0] ?? {}).sort()).toEqual(
      ['columns', 'name', 'order', 'primary', 'unique', 'where'].sort(),
    );
  });
});
