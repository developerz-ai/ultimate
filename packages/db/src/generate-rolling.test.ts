// `x db gen`'s half of a rolling deploy: a drop takes two releases, in the order the printed fix
// names. Walked end to end so the instruction cannot name a state the generator then refuses.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { destructiveStatements } from './destructive';
import { generateMigration, snapshotOf } from './generate';
import {
  columnKey,
  retiredColumnsIn,
  retiresMarker,
  rollingUnsafeStatements,
  unretiredColumnsIn,
  unretiresMarker,
} from './rolling';
import { AT, tableOf, textColumn, uuidColumn } from './rolling-fixture';
import { parseSnapshot } from './snapshot-parse';
import { statementsOf } from './statement-split';

const withLegacy = tableOf('posts', [textColumn('legacy')]);
const without = tableOf('posts');
const retired = tableOf('posts', [], { retired: ['legacy'] });

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof UltimateError) return error.code;
    throw error;
  }
  return expect.unreachable('expected a refusal');
};

describe('the refusal order', () => {
  const current = snapshotOf([withLegacy]);

  test('a column never retired is rolling-unsafe, with the flag or without', () => {
    for (const allowDestructive of [false, true]) {
      expect(
        codeOf(() =>
          generateMigration({ entities: [without], current, name: 'x', now: AT, allowDestructive }),
        ),
      ).toBe('X_MIGRATION_ROLLING_UNSAFE');
    }
  });

  test('--rolling-unsafe alone still meets the destructive gate', () => {
    expect(
      codeOf(() =>
        generateMigration({
          entities: [without],
          current,
          name: 'x',
          now: AT,
          rollingUnsafe: true,
        }),
      ),
    ).toBe('X_MIGRATION_IRREVERSIBLE');
  });

  test('both flags drop it and say so', () => {
    const migration = generateMigration({
      entities: [without],
      current,
      name: 'x',
      now: AT,
      rollingUnsafe: true,
      allowDestructive: true,
    });
    expect(migration.rollingUnsafe).toBe(true);
    expect(migration.destructive).toBe(true);
    expect(migration.up).toBe('alter table "posts" drop column "legacy";');
  });

  test('--rolling-unsafe is not recorded on a migration that dropped nothing unretired', () => {
    const migration = generateMigration({
      entities: [withLegacy, tableOf('orgs')],
      current,
      name: 'x',
      now: AT,
      rollingUnsafe: true,
    });
    expect(migration.rollingUnsafe).toBeUndefined();
  });

  test('the printed fix names the exact two-release path', () => {
    try {
      generateMigration({ entities: [without], current, name: 'x', now: AT });
    } catch (error) {
      const fix = error instanceof UltimateError ? error.fix : '';
      expect(fix).toContain(`entity('posts', { retired: ['legacy'] })`);
      expect(fix).toContain('x db gen "retire legacy"');
      expect(fix).toContain('x db gen "drop legacy" --allow-destructive');
      return;
    }
    expect.unreachable('expected a refusal');
  });
});

describe('the printed path, end to end', () => {
  test('retire, then remove: irreversible until the flag, then the drop and its markers', () => {
    const first = generateMigration({
      entities: [retired],
      current: snapshotOf([withLegacy]),
      name: 'retire legacy',
      now: AT,
    });
    expect(first.up).toBe('-- retires "posts"."legacy"');
    expect(statementsOf(first.up)).toEqual([]);
    expect(first.destructive).toBe(false);
    expect(first.transactional).toBe(true);
    const column = first.snapshot.tables[0]?.columns.find((each) => each.name === 'legacy');
    expect(column?.retired).toBe(true);

    // Survives the disk: the sidecar is what the next generation reads.
    const reread = parseSnapshot(JSON.parse(JSON.stringify(first.snapshot)));
    expect(reread?.tables[0]?.columns.find((each) => each.name === 'legacy')?.retired).toBe(true);

    // Still listed: nothing left to say.
    const quiet = generateMigration({ entities: [retired], current: reread, name: 'n', now: AT });
    expect(quiet.up).toBe('');

    expect(
      codeOf(() =>
        generateMigration({ entities: [without], current: reread, name: 'drop legacy', now: AT }),
      ),
    ).toBe('X_MIGRATION_IRREVERSIBLE');

    const second = generateMigration({
      entities: [without],
      current: reread,
      name: 'drop legacy',
      now: AT,
      allowDestructive: true,
    });
    expect(second.up).toBe(
      '-- contracts "posts"."legacy"\nalter table "posts" drop column "legacy";',
    );
    expect(second.destructive).toBe(true);
    expect(second.rollingUnsafe).toBeUndefined();
    expect(destructiveStatements(second.up).length).toBe(1);
    expect(second.snapshot.tables[0]?.columns.map((each) => each.name)).toEqual(['id']);
  });

  test('a retire leaves what hangs off the column recorded, and the drop takes it', () => {
    const indexed = tableOf(
      'posts',
      [
        uuidColumn('legacy', {
          notNull: false,
          references: 'posts.id',
          check: 'legacy is not null',
        }),
      ],
      {
        indexes: [
          {
            name: 'posts_legacy_idx',
            columns: ['legacy'],
            unique: false,
            where: null,
            order: null,
          },
        ],
      },
    );
    const current = snapshotOf([indexed]);
    const first = generateMigration({ entities: [retired], current, name: 'retire', now: AT });
    expect(first.up).toBe('-- retires "posts"."legacy"');
    const table = first.snapshot.tables[0];
    expect(table?.indexes.map((each) => each.name)).toEqual(['posts_legacy_idx']);
    expect(table?.foreignKeys.map((each) => each.name)).toEqual(['posts_legacy_fkey']);
    expect(table?.checks?.map((each) => each.name)).toEqual(['posts_legacy_check']);
    const second = generateMigration({
      entities: [without],
      current: first.snapshot,
      name: 'drop',
      now: AT,
      allowDestructive: true,
    });
    expect(second.up).toContain('drop column "legacy"');
    expect(second.up).not.toContain('drop index');
    expect(second.snapshot.tables[0]?.indexes).toEqual([]);
    expect(second.snapshot.tables[0]?.foreignKeys).toEqual([]);
  });

  test('declaring a retired column again records the un-retire, or the flag would stick', () => {
    const first = generateMigration({
      entities: [retired],
      current: snapshotOf([withLegacy]),
      name: 'retire',
      now: AT,
    });
    const back = generateMigration({
      entities: [withLegacy],
      current: first.snapshot,
      name: 'back',
      now: AT,
    });
    expect(back.up).toBe('-- unretires "posts"."legacy"');
    expect(
      back.snapshot.tables[0]?.columns.find((c) => c.name === 'legacy')?.retired,
    ).toBeUndefined();
  });

  test('the rail reads the un-retire: a retire taken back earns no later drop', () => {
    const up = `${retiresMarker('posts', 'legacy')}\n`;
    const back = `${unretiresMarker('posts', 'legacy')}\n`;
    expect(retiredColumnsIn(up)).toEqual([columnKey('posts', 'legacy')]);
    expect(unretiredColumnsIn(back)).toEqual([columnKey('posts', 'legacy')]);
    expect(unretiredColumnsIn(up)).toEqual([]);
  });

  test('what the rail reads off the generated files agrees with the generator', () => {
    const second = '-- contracts "posts"."legacy"\nalter table "posts" drop column "legacy";';
    expect(rollingUnsafeStatements(second, new Set([columnKey('posts', 'legacy')]))).toEqual([]);
    expect(rollingUnsafeStatements(second).length).toBe(1);
  });
});

describe('what cannot be retired', () => {
  test('a column another entity still references: the printed drop would be 2BP01', () => {
    const parent = tableOf('posts', [textColumn('slug', { unique: true })]);
    const child = tableOf('comments', [textColumn('post_slug', { references: 'posts.slug' })]);
    const retiring = tableOf('posts', [], { retired: ['slug'] });
    const current = snapshotOf([parent, child]);
    expect(
      codeOf(() => generateMigration({ entities: [retiring, child], current, name: 'x', now: AT })),
    ).toBe('X_MIGRATION_ROLLING_UNSAFE');
    // The child letting go in the same migration is what makes it retirable.
    const freed = tableOf('comments', [textColumn('post_slug')]);
    const both = generateMigration({ entities: [retiring, freed], current, name: 'x', now: AT });
    expect(both.up).toContain('-- retires "posts"."slug"');
  });

  test('a name the snapshot does not record', () => {
    expect(
      codeOf(() =>
        generateMigration({
          entities: [tableOf('posts', [], { retired: ['ghost'] })],
          current: snapshotOf([without]),
          name: 'x',
          now: AT,
        }),
      ),
    ).toBe('X_MIGRATION_ROLLING_UNSAFE');
  });

  test('a NOT NULL column with no default: the new pods inserts would fail', () => {
    const required = tableOf('posts', [textColumn('legacy', { notNull: true })]);
    expect(
      codeOf(() =>
        generateMigration({
          entities: [retired],
          current: snapshotOf([required]),
          name: 'x',
          now: AT,
        }),
      ),
    ).toBe('X_MIGRATION_ROLLING_UNSAFE');
  });

  test('a NOT NULL column with a default retires: the database still fills it', () => {
    const defaulted = tableOf('posts', [
      textColumn('legacy', {
        notNull: true,
        hasDefault: true,
        default: { kind: 'value', value: 'x' },
      }),
    ]);
    const current = snapshotOf([defaulted]);
    expect(current.tables[0]?.columns.find((c) => c.name === 'legacy')?.default).not.toBeNull();
    expect(generateMigration({ entities: [retired], current, name: 'x', now: AT }).up).toBe(
      '-- retires "posts"."legacy"',
    );
  });

  test('a name still declared in columns', () => {
    expect(
      codeOf(() =>
        generateMigration({
          entities: [tableOf('posts', [textColumn('legacy')], { retired: ['legacy'] })],
          current: snapshotOf([withLegacy]),
          name: 'x',
          now: AT,
        }),
      ),
    ).toBe('X_MIGRATION_ROLLING_UNSAFE');
  });
});
