// Single responsibility: a column's own CHECK is a named constraint that survives a regeneration.
// Every case here failed before `check-ddl.ts` existed: the predicate was written inline and
// anonymous into `create table`, `snapshotOf` recorded nothing, and `diffTable` had no arm for it —
// so the second `x db gen` turned `enumerated(POST_STATUSES)` into bare `text` accepting any string.

import { describe, expect, test } from 'bun:test';
import { checkClauses, checkPlan, columnCheckName, declaredChecks } from './check-ddl';
import { emptyConcurrentPlan } from './concurrent-plan';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import type { TableDescription } from './introspect';

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

const STATUS_CHECK = "status in ('draft', 'published')";

const posts = (overrides: Partial<EntityDescriptionLike> = {}): EntityDescriptionLike => ({
  name: 'Post',
  table: 'posts',
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('title', { notNull: true }),
    column('status', { notNull: true, check: STATUS_CHECK }),
  ],
  indexes: [],
  ...overrides,
});

const at = new Date('2026-08-25T00:00:00.000Z');

const migrate = (entity: EntityDescriptionLike, current?: EntityDescriptionLike): string =>
  generateMigration({
    entities: [entity],
    ...(current === undefined ? {} : { current: snapshotOf([current]) }),
    name: 'x',
    now: at,
  }).up;

describe('columnCheckName', () => {
  test("is Postgres' own name for an anonymous single-column CHECK", () => {
    expect(columnCheckName('posts', 'status')).toBe('posts_status_check');
  });

  test('refuses a column name that cannot be an identifier', () => {
    // The hole `columnName` carried: nothing validates a projected name, and this one closes the
    // quote and opens a second command inside `add constraint`.
    expect(() => columnCheckName('posts', 'n" , "x" text); drop table t; --')).toThrow(
      'X_SQL_UNSAFE',
    );
  });

  test('refuses a name Postgres would truncate to something another constraint already holds', () => {
    expect(() => columnCheckName('posts', 'c'.repeat(60))).toThrow('X_INVARIANT');
  });
});

describe('declaredChecks', () => {
  test("carries the column's own CHECK under the name Postgres mints for it", () => {
    expect(declaredChecks(posts())).toEqual([
      { name: 'posts_status_check', expression: STATUS_CHECK },
    ]);
  });

  test('refuses an invariant that names the constraint a column already owns', () => {
    // Two `add constraint` statements under one name is `42710` — a migration nobody can apply,
    // which is worse than either declaration being silently dropped.
    const clash = posts({
      invariants: [
        { name: 'status', kind: 'check', message: 'm', sql: "status <> ''", where: null },
      ],
    });
    expect(() => declaredChecks(clash)).toThrow('X_INVARIANT');
  });

  test('refuses a predicate holding a second command', () => {
    const injected = posts({
      columns: [column('status', { check: "status <> ''); drop table posts; --" })],
    });
    expect(() => declaredChecks(injected)).toThrow('X_SQL_UNSAFE');
  });
});

describe('createTable', () => {
  test('names the constraint instead of writing it inline and anonymous', () => {
    expect(checkClauses(posts())).toEqual([
      `constraint "posts_status_check" check (${STATUS_CHECK})`,
    ]);
    const up = migrate(posts());
    expect(up).toContain(`constraint "posts_status_check" check (${STATUS_CHECK})`);
    expect(up).not.toContain(`"status" text not null check (${STATUS_CHECK})`);
  });
});

describe('snapshotOf', () => {
  test("records the column's CHECK, so the next generation can see it", () => {
    const [table] = snapshotOf([posts()]).tables;
    expect(table?.checks).toEqual([{ name: 'posts_status_check', expression: STATUS_CHECK }]);
  });

  test('records no `checks` key at all on a table declaring none', () => {
    const bare = posts({ columns: [column('id', { kind: 'uuid', primaryKey: true })] });
    const [table] = snapshotOf([bare]).tables;
    expect(table === undefined ? 'missing' : 'checks' in table).toBe(false);
  });
});

describe('diffTable', () => {
  test('regenerating against its own snapshot emits nothing', () => {
    expect(migrate(posts(), posts())).toBe('');
  });

  test('a sidecar that predates the field ADDS the constraint, guarded', () => {
    // The repair path for every database generated before this landed. Postgres named the old
    // inline anonymous form `posts_status_check` itself, so an unguarded `add constraint` is
    // `42710` there — the drop is what makes the one statement correct on both databases.
    const recorded = posts({ columns: posts().columns.map((each) => ({ ...each, check: null })) });
    const up = migrate(posts(), recorded);
    expect(up).toContain('alter table "posts" drop constraint if exists "posts_status_check";');
    expect(up).toContain(
      `alter table "posts" add constraint "posts_status_check" check (${STATUS_CHECK}) not valid;`,
    );
    expect(up.indexOf('drop constraint if exists')).toBeLessThan(up.indexOf('add constraint'));
  });

  test('a column the entity stopped checking loses its constraint', () => {
    const unchecked = posts({
      columns: posts().columns.map((each) => ({ ...each, check: null })),
    });
    expect(migrate(unchecked, posts())).toContain(
      'alter table "posts" drop constraint "posts_status_check";',
    );
  });

  test('a value set that grew is a drop and an add of the same name', () => {
    const widened = posts({
      columns: posts().columns.map((each) =>
        each.column === 'status'
          ? { ...each, check: "status in ('draft', 'published', 'archived')" }
          : each,
      ),
    });
    const up = migrate(widened, posts());
    expect(up).toContain('alter table "posts" drop constraint "posts_status_check";');
    expect(up).toContain(
      `alter table "posts" add constraint "posts_status_check" ` +
        `check (status in ('draft', 'published', 'archived')) not valid;`,
    );
  });

  test('a NEW column carries no guard — the name provably cannot be taken', () => {
    const recorded = posts({ columns: posts().columns.filter((each) => each.column !== 'status') });
    const up = migrate(posts(), recorded);
    expect(up).toContain('add column "status" text');
    expect(up).toContain(
      `alter table "posts" add constraint "posts_status_check" check (${STATUS_CHECK}) not valid;`,
    );
    expect(up).not.toContain('drop constraint if exists');
  });

  test('the constraint is added AFTER the column it reads', () => {
    const recorded = posts({ columns: posts().columns.filter((each) => each.column !== 'status') });
    const up = migrate(posts(), recorded);
    // `indexOf` answers -1 for a statement never emitted, and -1 is below every real index — so
    // the ordering below holds for an `up` that adds no column at all. Pinned present first.
    expect(up).toContain('add column "status"');
    // `add constraint` on a column that does not exist yet is `42703`.
    expect(up.indexOf('add column "status"')).toBeLessThan(up.indexOf('add constraint'));
  });

  test('a column rebuilt outright gets its CHECK back', () => {
    // `regenerate`'s plain -> generated path is `drop column` + `add column`, which takes the
    // constraint with it — and the snapshot still records it, so nothing would put it back.
    const generated = posts({
      columns: [
        column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
        column('title', { notNull: true }),
        column('status', { notNull: true, check: STATUS_CHECK, generated: 'lower(title)' }),
      ],
    });
    const up = migrate(generated, posts());
    expect(up).toContain('drop column "status";');
    expect(up).toContain(
      `alter table "posts" add constraint "posts_status_check" check (${STATUS_CHECK});`,
    );
  });
});

describe('a live table, online', () => {
  const unchecked = posts({ columns: posts().columns.map((each) => ({ ...each, check: null })) });
  const VALIDATE = 'alter table "posts" validate constraint "posts_status_check";';

  test('an added check is not valid in the transaction, validated in the deferred step', () => {
    const migration = generateMigration({
      entities: [posts()],
      current: snapshotOf([unchecked]),
      name: 'x',
      now: new Date('2026-11-02T00:00:00.000Z'),
    });
    expect(migration.transactional).toBe(true);
    expect(migration.up).toContain(`check (${STATUS_CHECK}) not valid;`);
    expect(migration.up).not.toContain('validate constraint');
    expect(migration.followUp?.transactional).toBe(false);
    expect(migration.followUp?.up).toContain(VALIDATE);
    // A validate reverses to nothing: the transactional step's `down` drops the constraint.
    expect(migration.followUp?.down).toBe('');
  });

  test('a new table stays plain, byte for byte', () => {
    const migration = generateMigration({
      entities: [posts()],
      name: 'x',
      now: new Date('2026-11-02T00:00:00.000Z'),
    });
    expect(migration.followUp).toBeUndefined();
    expect(migration.up).toContain(`constraint "posts_status_check" check (${STATUS_CHECK})`);
    expect(migration.up).not.toContain('not valid');
  });

  test('a check that did not move writes neither half', () => {
    const migration = generateMigration({
      entities: [posts()],
      current: snapshotOf([posts()]),
      name: 'x',
      now: new Date('2026-11-02T00:00:00.000Z'),
    });
    expect(migration.up).toBe('');
    expect(migration.followUp).toBeUndefined();
  });

  test('a constraint a retype moved aside comes back plain, the rewrite holds the table anyway', () => {
    const plan = { up: [] as string[], down: [] as string[] };
    const concurrent = emptyConcurrentPlan();
    const live = snapshotOf([posts()]).tables[0];
    if (live === undefined) return expect.unreachable('the snapshot holds the table');
    checkPlan(posts(), live, plan, new Set(), new Set(['posts_status_check']), concurrent);
    expect(plan.up).toEqual([
      `alter table "posts" add constraint "posts_status_check" check (${STATUS_CHECK});`,
    ]);
    expect(concurrent.validate).toEqual([]);
  });
});

describe('checkPlan', () => {
  const live = (checks?: readonly { name: string; expression: string }[]): TableDescription => ({
    schema: 'public',
    name: 'posts',
    columns: [
      { name: 'id', dataType: 'uuid', nullable: false, default: null, position: 1 },
      { name: 'status', dataType: 'text', nullable: false, default: null, position: 2 },
    ],
    primaryKey: ['id'],
    indexes: [],
    foreignKeys: [],
    ...(checks === undefined ? {} : { checks }),
  });

  test('the down of a guarded add drops the constraint it added', () => {
    const plan = { up: [] as string[], down: [] as string[] };
    checkPlan(posts(), live(), plan);
    expect(plan.down).toEqual(['alter table "posts" drop constraint "posts_status_check";']);
  });

  test('a column declaring no CHECK is never named — the plan does not refuse over it', () => {
    // `columnCheckName` refuses a name it cannot spell, so asking it about every column would make
    // a migration that touches none of them ungeneratable.
    const long = 'c'.repeat(80);
    const wide = posts({ columns: [...posts().columns, column(long)] });
    // Present in the recorded schema too, which is the only set `exposed` is built from.
    const recorded = live();
    const held: TableDescription = {
      ...recorded,
      columns: [
        ...recorded.columns,
        { name: long, dataType: 'text', nullable: true, default: null, position: 3 },
      ],
    };
    const plan = { up: [] as string[], down: [] as string[] };
    expect(() => checkPlan(wide, held, plan)).not.toThrow();
  });

  test('a recorded constraint that still matches moves nothing', () => {
    const plan = { up: [] as string[], down: [] as string[] };
    checkPlan(posts(), live([{ name: 'posts_status_check', expression: STATUS_CHECK }]), plan);
    expect(plan.up).toEqual([]);
  });
});
