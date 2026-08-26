// Which foreign keys a retype breaks, where the statements land, and the three ways the ordinary
// key diff has to stay out of their way. The failure each of these pins is `42804 foreign key
// constraint … cannot be implemented` inside `ROLE=migrate`, or its mirror on the way back —
// `generate-retype-key.live.test.ts` is where both are measured against a real server.

import { describe, expect, test } from 'bun:test';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { unrestorableNote } from './foreign-key';
import type { Plan } from './foreign-key-plan';
import { generateMigration, snapshotOf } from './generate';
import type { SchemaDescription } from './introspect';
import { moveKeysAside, retypedColumns, retypedIn } from './retype-keys';
import { statementsOf } from './statement-split';

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

const orgs = (kind: string): EntityDescriptionLike => ({
  name: 'Org',
  table: 'orgs',
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('code', { kind, notNull: true, unique: true }),
  ],
  indexes: [],
});

const posts = (
  kind: string,
  reference: Partial<ColumnDescriptionLike> = { references: 'orgs.code' },
): EntityDescriptionLike => ({
  name: 'Post',
  table: 'posts',
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('org_code', { kind, ...reference }),
  ],
  indexes: [],
});

const before = (): SchemaDescription => snapshotOf([orgs('integer'), posts('integer')]);

const migration = (entities: readonly EntityDescriptionLike[]) =>
  generateMigration({
    entities,
    current: before(),
    name: 'code to text',
    now: new Date('2026-08-25T00:00:00.000Z'),
  });

const indexOf = (script: string, needle: string): number =>
  statementsOf(script).findIndex((statement) => statement.includes(needle));

describe('retypedColumns', () => {
  test('a column whose physical type moved is in the set, on the table that holds it', () => {
    const moved = retypedColumns([orgs('text'), posts('text')], before());
    expect([...retypedIn(moved, 'orgs')]).toEqual(['code']);
    expect([...retypedIn(moved, 'posts')]).toEqual(['org_code']);
  });

  test('a kind that renders to the type already recorded is not a retype', () => {
    expect(retypedColumns([orgs('integer'), posts('integer')], before()).size).toBe(0);
  });

  test('a table the recorded schema does not hold contributes nothing — it is a create', () => {
    expect(retypedColumns([orgs('text')], { tables: [] }).size).toBe(0);
  });

  test('a GENERATED column is left to generated-column.ts, whichever side declares one', () => {
    const generated = (kind: string): EntityDescriptionLike => ({
      ...orgs(kind),
      columns: [
        column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
        column('code', { kind, notNull: true, generated: "upper('a')" }),
      ],
    });
    const recorded = snapshotOf([generated('integer')]);
    expect(retypedColumns([generated('text')], recorded).size).toBe(0);
  });
});

describe('moveKeysAside', () => {
  const run = (
    entities: readonly EntityDescriptionLike[],
    doomed: ReadonlySet<string> = new Set(),
  ): { readonly plan: Plan; readonly moved: ReadonlySet<string> } => {
    const plan: Plan = { up: [], down: [] };
    const current = before();
    const moved = moveKeysAside(current, retypedColumns(entities, current), doomed, plan);
    return { plan, moved };
  };

  // The whole reason this lives above `diffTable`: the column that moves is on `orgs`, and the
  // constraint that breaks is recorded on `posts`, which `diffTable(orgs)` is never handed.
  test('a key is moved when the retyped column is its TARGET, in another table entirely', () => {
    const { plan, moved } = run([orgs('text'), posts('text')]);
    expect([...moved]).toEqual([JSON.stringify(['posts', 'posts_org_code_fkey'])]);
    expect(plan.up).toEqual(['alter table "posts" drop constraint "posts_org_code_fkey";']);
    expect(plan.down[0]).toContain('add constraint "posts_org_code_fkey"');
  });

  // The case the TARGET arm exists for, and the only one where the two arms do not overlap: the
  // key's own table is being DROPPED, so nothing retypes its column and `foreignKeyPlan` is never
  // called for it at all — but `drop table "posts"` runs at the END of `up`, long after the ALTER
  // it would have unblocked. Measured without this: `42804` on `alter table "orgs"`.
  test('a key on a table this migration DROPS is still moved aside', () => {
    const { plan, moved } = run([orgs('text')], new Set(['posts']));
    expect([...moved]).toEqual([JSON.stringify(['posts', 'posts_org_code_fkey'])]);
    expect(plan.up).toEqual(['alter table "posts" drop constraint "posts_org_code_fkey";']);
    // The note is `foreign-key.ts`'s ONE text, never a second spelling here: `unrestorableDrop`
    // says the same thing about the same failed rollback, and the two had already drifted.
    expect(plan.down[0]).toBe(unrestorableNote('posts', 'posts_org_code_fkey', 'posts'));
  });

  test('a key touching no retyped column is left alone — the ALTER never sees it', () => {
    const untouched = (kind: string): EntityDescriptionLike => ({
      ...posts('integer'),
      columns: [
        column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
        column('org_code', { kind: 'integer', references: 'orgs.code' }),
        column('slug', { kind }),
      ],
    });
    const plan: Plan = { up: [], down: [] };
    const current = snapshotOf([orgs('integer'), untouched('text')]);
    const entities = [orgs('integer'), untouched('uuid')];
    const moved = moveKeysAside(current, retypedColumns(entities, current), new Set(), plan);
    expect(moved.size).toBe(0);
    expect(plan.up).toEqual([]);
  });

  test('a key whose target is being dropped gets a note in down, never an add it cannot run', () => {
    const { plan } = run([posts('text')], new Set(['orgs']));
    expect(plan.up).toEqual(['alter table "posts" drop constraint "posts_org_code_fkey";']);
    // The TARGET is what is gone here, and the note names it — the same wording, one writer.
    expect(plan.down[0]).toBe(unrestorableNote('posts', 'posts_org_code_fkey', 'orgs'));
  });
});

describe('the assembled migration', () => {
  test('the drop precedes every ALTER and the add follows every one of them', () => {
    const up = migration([orgs('text'), posts('text')]).up;
    const statements = statementsOf(up);
    const alters = statements
      .map((each, index) => (each.includes('alter column') ? index : -1))
      .filter((index) => index >= 0);
    expect(alters.length).toBe(2);
    // Presence FIRST, in both directions: `findIndex` answers -1 for a needle it never found, and
    // -1 is less than every real index — so `drop < min(alters)` passed with the drop deleted from
    // `moveKeysAside` outright. The same shape `generate-retype-key.live.test.ts` already writes.
    const dropped = indexOf(up, 'drop constraint "posts_org_code_fkey"');
    const added = indexOf(up, 'add constraint "posts_org_code_fkey"');
    expect(dropped).toBeGreaterThanOrEqual(0);
    expect(added).toBeGreaterThanOrEqual(0);
    expect(dropped).toBeLessThan(Math.min(...alters));
    expect(added).toBeGreaterThan(Math.max(...alters));
  });

  test('down drops the new key first and re-adds the recorded one last', () => {
    const statements = statementsOf(migration([orgs('text'), posts('text')]).down);
    expect(statements[0]).toContain('drop constraint "posts_org_code_fkey"');
    expect(statements.at(-1)).toContain('add constraint "posts_org_code_fkey"');
    const alters = statements
      .map((each, index) => (each.includes('alter column') ? index : -1))
      .filter((index) => index >= 0);
    expect(Math.max(...alters)).toBeLessThan(statements.length - 1);
  });

  // Dropping it twice is `42704` on the second, and the ordinary arm's drop runs AFTER the ALTER
  // that needed it gone — so suppressing it is not tidiness, it is the fix.
  test('a reference the entity dropped is dropped ONCE, by the retype and not again', () => {
    const up = migration([orgs('text'), posts('text', { references: null })]).up;
    const drops = statementsOf(up).filter((each) =>
      each.includes('drop constraint "posts_org_code_fkey"'),
    );
    expect(drops.length).toBe(1);
    expect(up).not.toContain('add constraint "posts_org_code_fkey"');
    // `down` still restores it: a migration that cannot be reversed is not one this package writes.
    expect(migration([orgs('text'), posts('text', { references: null })]).down).toContain(
      'add constraint "posts_org_code_fkey"',
    );
  });

  test('an on delete rule that moved comes back carrying the new rule, added once', () => {
    const changed = posts('text', { references: 'orgs.code', onDelete: 'cascade' });
    const up = migration([orgs('text'), changed]).up;
    const adds = statementsOf(up).filter((each) =>
      each.includes('add constraint "posts_org_code_fkey"'),
    );
    expect(adds.length).toBe(1);
    expect(adds[0]).toContain('on delete cascade');
    // The reversal restores the recorded rule, which is no rule at all.
    const down = statementsOf(migration([orgs('text'), changed]).down);
    expect(down.at(-1)).not.toContain('on delete');
  });

  test('a migration that retypes nothing is byte-identical to the one it always emitted', () => {
    expect(migration([orgs('integer'), posts('integer')]).up).toBe('');
  });
});
