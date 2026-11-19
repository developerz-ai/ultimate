// The detector against the generator itself: a refusal on `x db migrate` is only safe if nothing
// the generator writes in a straight line can look like a fork. Each step below is one real diff,
// including those whose work lands in a `-- transaction: false` follow-up.

import { expect, test } from 'bun:test';
import type {
  ColumnDescriptionLike,
  EntityDescriptionLike,
  IndexDescriptionLike,
} from './entity-shape';
import type { GeneratedMigration } from './generate';
import { generateMigration } from './generate';
import type { SchemaDescription } from './introspect';
import { migrationFork } from './migration-fork';
import type { Migration } from './migration-ledger';

const column = (
  name: string,
  overrides: Partial<ColumnDescriptionLike> = {},
): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: 'text',
  notNull: false,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
  ...overrides,
});

const ID = column('id', { kind: 'uuid', primaryKey: true, notNull: true, hasDefault: true });

const index = (name: string, columns: readonly string[]): IndexDescriptionLike => ({
  name,
  columns,
  unique: false,
  where: null,
  order: null,
});

const entity = (
  table: string,
  overrides: Partial<EntityDescriptionLike> = {},
): EntityDescriptionLike => ({
  name: table,
  table,
  primaryKey: ['id'],
  columns: [ID],
  indexes: [],
  ...overrides,
});

const NOTE = column('note');
const OWNER = column('owner_id', { kind: 'uuid', references: 'owners.id' });
const NOTE_CHECK = {
  name: 'note_short',
  kind: 'check',
  message: 'm',
  sql: 'length(note) < 9',
  where: null,
} as const;

/** Each entry is the whole declared schema at one point in an app's life. */
const LIFE: readonly (readonly EntityDescriptionLike[])[] = [
  [entity('posts')],
  [entity('posts', { columns: [ID, NOTE] })],
  [
    entity('posts', {
      columns: [ID, NOTE],
      indexes: [{ ...index('posts_note_key', ['note']), unique: true }],
    }),
  ],
  [entity('posts', { columns: [ID, NOTE] })],
  [entity('posts', { columns: [ID, NOTE], indexes: [index('posts_note_idx', ['note'])] })],
  [entity('posts', { columns: [ID, NOTE], invariants: [NOTE_CHECK] })],
  [entity('posts', { columns: [ID, NOTE] }), entity('owners')],
  [entity('posts', { columns: [ID, NOTE, OWNER] }), entity('owners')],
  [entity('posts', { columns: [ID, NOTE] }), entity('owners')],
  [entity('posts'), entity('owners')],
  [entity('owners')],
  [entity('owners'), entity('posts')],
];

const asStep = (generated: GeneratedMigration, order: number): Migration => ({
  id: `${String(order).padStart(4, '0')}_${generated.name}`,
  name: generated.name,
  up: generated.up,
  down: generated.down,
  snapshot: generated.snapshot,
});

test('a chain the generator wrote in a straight line is never a fork, at any point', () => {
  const chain: Migration[] = [];
  let current: SchemaDescription = { tables: [] };
  LIFE.forEach((entities, at) => {
    const generated = generateMigration({
      entities,
      current,
      name: `step ${String(at)}`,
      allowDestructive: true,
      rollingUnsafe: true,
    });
    expect(generated.up.trim()).not.toBe('');
    chain.push(asStep(generated, chain.length));
    const followUp = generated.followUp;
    if (followUp !== undefined) chain.push(asStep(followUp, chain.length));
    current = (followUp ?? generated).snapshot;
    expect({ at, fork: migrationFork(chain) }).toEqual({ at, fork: undefined });
  });
});
