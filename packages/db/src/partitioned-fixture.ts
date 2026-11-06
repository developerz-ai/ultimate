// TEST-ONLY. A partitioned `events` table the way an app declares one: `x db gen` writes the
// migration from an entity, the author hand-edits `partition by range ("at")` onto its `create
// table`, and a second migration attaches a partition. One copy, so the embedded and the live
// suites judge the same migrations. Never exported from `index.ts`.

import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration } from './generate';
import type { Migration } from './migration-ledger';

const column = (name: string, kind: string): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind,
  notNull: true,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
});

/** The primary key holds the partition key: Postgres refuses any unique index that does not. */
export const EVENTS: EntityDescriptionLike = {
  name: 'Event',
  table: 'events',
  primaryKey: ['id', 'at'],
  columns: [column('id', 'uuid'), column('at', 'timestamp'), column('kind', 'text')],
  indexes: [
    { name: 'events_kind_idx', columns: ['kind'], unique: false, where: null, order: null },
  ],
};

const generated = generateMigration({
  entities: [EVENTS],
  name: 'create events',
  now: new Date('2026-11-01T00:00:00.000Z'),
});

/** The one hand edit the recipe makes: the generated `create table`'s closing `);` only. */
const partitioned = generated.up.replace(
  /(create table "events" \([\s\S]*?\n)\);/,
  '$1) partition by range ("at");',
);

/** The partition statement an app's monthly `task` runs, `if not exists` so a re-run is a no-op. */
export const partitionFor = (month: string, from: string, to: string): string =>
  `create table if not exists "events_${month}" partition of "events" ` +
  `for values from ('${from}') to ('${to}')`;

export const CREATE_EVENTS: Migration = {
  id: generated.id,
  name: generated.name,
  up: `${partitioned}\n${partitionFor('2026_11', '2026-11-01', '2026-12-01')};`,
  down: generated.down,
  snapshot: generated.snapshot,
};

/** True when the hand edit landed — a fixture whose regex missed would test a plain table. */
export const fixtureIsPartitioned = (): boolean => partitioned.includes('partition by range');
