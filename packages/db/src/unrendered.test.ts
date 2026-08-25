// Single responsibility: what `x db gen` says out loud about a rule it is about to TAKE AWAY. The
// case that shipped: an `assert` invariant whose CHECK a previous migration recorded reads as
// "declares nothing in SQL", so the plan drops the constraint and the unrendered list stayed empty
// — which made `@ultimat3/cli`'s `repairFix` hand out `x db gen "drop <name>"` as the repair for
// the very loss that command performs. Five constraints in `examples/dummy`, none of them reported.

import { describe, expect, test } from 'bun:test';
import type {
  ColumnDescriptionLike,
  EntityDescriptionLike,
  InvariantDescriptionLike,
} from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import type { SchemaDescription } from './introspect';
import { unrenderedOf } from './unrendered';

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

/** `examples/dummy`'s `posts`, reduced to the two columns the dropped rules read. */
const posts = (invariants: readonly InvariantDescriptionLike[]): EntityDescriptionLike => ({
  name: 'Post',
  table: 'posts',
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('slug', { notNull: true }),
  ],
  indexes: [],
  invariants,
});

/** `invariant('post_slug_shape', c.slug.matches(isValidSlug))` — a JS predicate, so `sql: null`. */
const slugShapeAssert: InvariantDescriptionLike = {
  name: 'post_slug_shape',
  kind: 'assert',
  message: 'slug must be a slug',
  sql: null,
  where: null,
};

const SLUG_EXPRESSION = "slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'";

/**
 * What `0001_init.sql` wrote and what the newest sidecar records: the constraint under the rule's
 * OWN name, which is what a hand-written migration calls it.
 */
const recordedWithCheck = (checkName: string): SchemaDescription => {
  const [table] = snapshotOf([posts([])]).tables;
  if (table === undefined) expect.unreachable('the fixture entity must produce one table');
  return { tables: [{ ...table, checks: [{ name: checkName, expression: SLUG_EXPRESSION }] }] };
};

const at = new Date('2026-08-25T00:00:00.000Z');

const generate = (entity: EntityDescriptionLike, current: SchemaDescription) =>
  generateMigration({ entities: [entity], current, name: 'probe drift', now: at });

describe('unrenderedOf · an app-judged rule the database already enforces', () => {
  test('an assert whose CHECK a migration recorded is REPORTED, never dropped in silence', () => {
    const migration = generate(posts([slugShapeAssert]), recordedWithCheck('post_slug_shape'));
    // The drop is real and stays real — this is what an author would have run.
    expect(migration.up).toContain('alter table "posts" drop constraint "post_slug_shape";');
    expect(migration.unrendered).toHaveLength(1);
    expect(migration.unrendered[0]?.kind).toBe('invariant');
    expect(migration.unrendered[0]?.table).toBe('posts');
    // The RECORDED name: the string in the drop statement, in the sidecar, and in the drift
    // finding `repairFix` matches this entry against.
    expect(migration.unrendered[0]?.name).toBe('post_slug_shape');
    expect(migration.unrendered[0]?.fix).toContain("invariant('post_slug_shape'");
    expect(migration.up).toContain('-- UNRENDERED');
    expect(migration.up).toContain('"posts"."post_slug_shape"');
  });

  test('the constraint this generator would have named is matched too — a check that became an assert', () => {
    // `posts_post_slug_shape_check` is what a PREVIOUS `x db gen` recorded while the same rule was
    // still SQL-expressible. Rewriting it as a JS predicate must not make the drop silent.
    const migration = generate(
      posts([slugShapeAssert]),
      recordedWithCheck('posts_post_slug_shape_check'),
    );
    expect(migration.up).toContain(
      'alter table "posts" drop constraint "posts_post_slug_shape_check";',
    );
    expect(migration.unrendered).toHaveLength(1);
    expect(migration.unrendered[0]?.name).toBe('posts_post_slug_shape_check');
  });

  test('an assert with nothing recorded behind it reports NOTHING — a marker on all marks none', () => {
    // The other half of the asymmetry, and the reason this is not a widened predicate: a rule the
    // database was never told about loses nothing, and reporting it would put a block on nearly
    // every app's every migration forever.
    const current = snapshotOf([posts([])]);
    const migration = generate(posts([slugShapeAssert]), current);
    expect(migration.unrendered).toEqual([]);
    expect(migration.up).not.toContain('UNRENDERED');
  });

  test('it is self-clearing — the generation AFTER the drop reports nothing again', () => {
    const entity = posts([slugShapeAssert]);
    const first = generate(entity, recordedWithCheck('post_slug_shape'));
    expect(first.unrendered).toHaveLength(1);
    // `first.snapshot` is what the sidecar beside that migration holds.
    expect(unrenderedOf([entity], first.snapshot)).toEqual([]);
  });

  test('a check invariant is not reported — the generator rewrites it under its own name', () => {
    const rendered: InvariantDescriptionLike = {
      name: 'post_slug_shape',
      kind: 'check',
      message: 'slug must be a slug',
      sql: SLUG_EXPRESSION,
      where: null,
    };
    const migration = generate(posts([rendered]), recordedWithCheck('post_slug_shape'));
    // Dropped under the hand-written name and re-added under the generated one: a rename, not a
    // loss, and reporting it would be a marker on a migration that lost nothing.
    expect(migration.up).toContain(
      'alter table "posts" add constraint "posts_post_slug_shape_check" ' +
        `check (${SLUG_EXPRESSION});`,
    );
    expect(migration.unrendered).toEqual([]);
  });

  test("an assert named after a COLUMN does not claim that column's own CHECK is being dropped", () => {
    // `<table>_<column>_check` is what a column's CHECK is called and `<table>_<name>_check` is what
    // an invariant's is, so an assert named `slug` derives the same `posts_slug_check` the column
    // owns. `namesConstraint` matches on the name alone — it has to, because a hand-written
    // migration used the rule's own — so the discriminator has to be what this run still DECLARES.
    const slugAssert: InvariantDescriptionLike = { ...slugShapeAssert, name: 'slug' };
    const checked: EntityDescriptionLike = {
      ...posts([slugAssert]),
      columns: [
        column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
        column('slug', { notNull: true, check: SLUG_EXPRESSION }),
      ],
    };
    const [table] = snapshotOf([checked]).tables;
    if (table === undefined) expect.unreachable('the fixture entity must produce one table');
    const migration = generate(checked, { tables: [table] });
    // Nothing is dropped, so nothing is unrendered — a marker on a migration that lost nothing is
    // a marker the next reviewer learns to ignore.
    expect(migration.up).not.toContain('drop constraint');
    expect(migration.unrendered).toEqual([]);
  });

  test('and the same assert IS reported when the column declares no CHECK of its own', () => {
    // The other side of the discriminator: with nothing on the column, `posts_slug_check` is a
    // constraint a previous migration recorded for the RULE, and this run genuinely drops it.
    const slugAssert: InvariantDescriptionLike = { ...slugShapeAssert, name: 'slug' };
    const migration = generate(posts([slugAssert]), recordedWithCheck('posts_slug_check'));
    expect(migration.up).toContain('alter table "posts" drop constraint "posts_slug_check";');
    expect(migration.unrendered).toHaveLength(1);
    expect(migration.unrendered[0]?.name).toBe('posts_slug_check');
  });

  test('an assert carrying an expression is not reported — `declaredChecks` renders it', () => {
    // `kind` and `sql` are read as the pair `hasJsOnlyInvariant` reads: a description whose kind
    // says assert while an expression sits beside it is rendered, so nothing is lost.
    const contradictory: InvariantDescriptionLike = {
      ...slugShapeAssert,
      kind: 'assert',
      sql: SLUG_EXPRESSION,
    };
    expect(unrenderedOf([posts([contradictory])], recordedWithCheck('post_slug_shape'))).toEqual(
      [],
    );
  });

  test('a recorded name that is not an identifier reaches no comment and no fix', () => {
    // A sidecar is a hand-editable file and an invariant name is validated by nobody at
    // declaration, so BOTH sides of the match can carry a `\n` — which ENDS a `--` line comment and
    // would put the rest of the entry into the migration as real SQL. Reported by nothing, and
    // refused one call earlier, where the drop statement is built.
    const injected = 'post_slug_shape\ndrop table posts; --';
    const entity = posts([{ ...slugShapeAssert, name: injected }]);
    const current = recordedWithCheck(injected);
    expect(unrenderedOf([entity], current)).toEqual([]);
    try {
      generate(entity, current);
      expect.unreachable('a recorded constraint name holding a newline must be refused');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('X_SQL_UNSAFE');
    }
  });

  test('no recorded schema at all is answered, never assumed — the first migration', () => {
    expect(unrenderedOf([posts([slugShapeAssert])], undefined)).toEqual([]);
  });
});
