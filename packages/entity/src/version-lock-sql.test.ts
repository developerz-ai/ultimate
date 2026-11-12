// The declared lock in the Postgres statements: every UPDATE increments the version, one naming
// the version it read is conditioned on it, and `updateMany` conditions each row on its own.

import { afterAll, describe, expect, test } from 'bun:test';
import { integer, text, uuid } from './columns';
import { entity } from './entity';
import { updateManyStatements } from './pg-update-many-sql';
import { updateStatement } from './pg-write-sql';
import { planFor } from './plan';
import { clearRegistry } from './registry';
import { updateManyPlan } from './update-many';

afterAll(() => {
  clearRegistry();
});

const ID = '0190a5d2-0000-7000-8000-000000000001';
const columnsOf = () => ({
  id: uuid().primaryKey(),
  title: text(),
  lockVersion: integer().default(0).column('lock_v'),
});
const posts = Object.defineProperty(entity('vl_posts', { columns: columnsOf() }), '$version', {
  value: 'lockVersion',
});
const plain = entity('vl_plain', { columns: columnsOf() });
const byId = (core: typeof plain) =>
  planFor(core, { where: [{ column: 'id', op: 'eq', value: ID }] });
const shape = { includeDeleted: false };

describe('unit · updateStatement under a declared lock', () => {
  test('naming the version: conditioned on it, set one past it, never set to it', () => {
    const values = new Map<string, unknown>([
      ['title', 'new'],
      ['lock_v', 3],
    ]);
    const { text: statement, values: bound } = updateStatement(
      posts,
      byId(posts),
      values,
      shape,
      true,
    );
    expect(statement).toContain('"lock_v" = "lock_v" + 1');
    expect(statement).not.toMatch(/"lock_v" = \$\d+,/);
    expect(statement).toMatch(/"lock_v" = \$\d+ returning/);
    expect(bound).toContain(3);
  });

  test('a filtered write naming no version still increments it, unconditioned', () => {
    const values = new Map<string, unknown>([['title', 'new']]);
    const { text: statement } = updateStatement(posts, byId(posts), values, shape, false);
    expect(statement).toContain('"lock_v" = "lock_v" + 1');
    expect(statement).not.toMatch(/"lock_v" = \$/);
  });

  test('an unversioned entity compiles exactly as before', () => {
    const values = new Map<string, unknown>([['lock_v', 3]]);
    const { text: statement } = updateStatement(plain, byId(plain), values, shape, false);
    expect(statement).not.toContain('+ 1');
    expect(statement).toMatch(/set "lock_v" = \$1 where/);
  });
});

describe('unit · updateManyStatements under a declared lock', () => {
  test('each row is conditioned on its own version and incremented', () => {
    const plan = updateManyPlan(posts, [{ id: ID, patch: { title: 'a', lockVersion: 2 } }], {});
    const [statement] = updateManyStatements(posts, plan, false);
    const sqlText = statement?.text ?? '';
    expect(sqlText).toContain('"lock_v" = "vl_posts"."lock_v" + 1');
    expect(sqlText).toMatch(/"vl_posts"\."lock_v" = "v"\."C\d+\$UM"/);
  });

  test('a row naming no version is refused before a statement exists', () => {
    expect(() => updateManyPlan(posts, [{ id: ID, patch: { title: 'a' } }], {})).toThrow(
      /X_ENTITY_VERSION_INVALID/,
    );
  });
});
