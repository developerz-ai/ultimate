// A recorded `dataType` across the sidecar boundary. It is spliced into `down` by every arm that
// puts a column back, so a `.snapshot.json` anything may edit must not be able to carry a second
// statement in it: the screen a recorded default and a generation expression already take.

import { describe, expect, test } from 'bun:test';
import { parseSnapshot } from './snapshot-parse';

const sidecar = (dataType: string): unknown => ({
  tables: [
    {
      schema: 'public',
      name: 'posts',
      primaryKey: ['id'],
      columns: [
        { name: 'id', dataType: 'uuid', nullable: false, default: null, position: 1 },
        { name: 'legacy', dataType, nullable: true, default: null, position: 2 },
      ],
      indexes: [],
      foreignKeys: [],
    },
  ],
});

describe('parseSnapshot · dataType', () => {
  test('a dataType holding a second statement is refused, never spliced into down', () => {
    // Measured before the screen: `… add column "legacy" text; drop table users; -- data is not
    // restored` in the `down` of the migration that drops the column.
    expect(parseSnapshot(sidecar('text; drop table users'))).toBeUndefined();
  });

  test.each([
    'text',
    'uuid',
    'char(3)',
    'numeric(20, 0)',
    'timestamp with time zone',
    'text[]',
    'varchar(20)',
  ])('a type this generator writes is read as it was recorded: %s', (dataType) => {
    expect(parseSnapshot(sidecar(dataType))?.tables[0]?.columns[1]?.dataType).toBe(dataType);
  });
});
