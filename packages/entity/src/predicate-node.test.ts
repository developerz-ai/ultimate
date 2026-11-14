// The predicate tree's own refusals and its one-statement shape. The rows every driver answers are
// `@ultimat3/testing`'s conformance (`entity-conformance-tree.ts`); here: what is refused before a
// driver is reached, what a driver refuses that bypassed planning, and the SQL a tree compiles to.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { recordingClient } from '@ultimat3/db';
import { text, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { MAX_PREDICATE_DEPTH, nodePredicate } from './predicate-node';
import { clearRegistry } from './registry';

const notes = entity('predicate_node_notes', {
  columns: {
    id: uuid().primaryKey(),
    authorId: uuid(),
    kind: text({ max: 10 }),
    secret: text({ max: 40 }).sealed(),
  },
});
const people = entity('predicate_node_people', {
  columns: { id: uuid().primaryKey(), kind: text({ max: 10 }) },
});

afterAll(() => {
  clearRegistry();
});

const codeOf = async (run: () => unknown): Promise<string> => {
  try {
    await run();
    return 'resolved';
  } catch (error) {
    return isUltimateError(error) ? error.code : `uncoded: ${String(error)}`;
  }
};

const INVALID = 'X_ENTITY_PREDICATE_NODE_INVALID';
const leaf = { column: 'kind', op: 'eq', value: 'a' } as const;
const nested = (depth: number): unknown => (depth === 0 ? leaf : { or: [nested(depth - 1)] });

describe('andWhereNode — refused before any driver', () => {
  const db = database({ notes, people }, { driver: memoryDriver() });

  test(`a tree ${MAX_PREDICATE_DEPTH} levels deep plans; one level more is refused`, async () => {
    expect(() => nodePredicate('n', nested(MAX_PREDICATE_DEPTH))).not.toThrow();
    expect(await codeOf(() => nodePredicate('n', nested(MAX_PREDICATE_DEPTH + 1)))).toBe(INVALID);
  });

  test('a malformed node or an unknown leaf operator is refused, not read as no rows', async () => {
    expect(await codeOf(() => nodePredicate('n', { or: 'kind' }))).toBe(INVALID);
    expect(await codeOf(() => nodePredicate('n', { via: { column: 'id' }, where: [] }))).toBe(
      INVALID,
    );
    expect(await codeOf(() => nodePredicate('n', { column: 'kind', op: '>', value: 1 }))).toBe(
      'X_ENTITY_OPERATOR_UNKNOWN',
    );
  });

  test('andWhere cannot name a node op: the tree has one door', async () => {
    const chain = () => db.notes.andWhere('kind', 'or' as never, []).all();
    expect(await codeOf(chain)).toBe('X_ENTITY_OPERATOR_UNKNOWN');
  });

  test('a via naming an unregistered entity, an undeclared or a sealed column is refused', async () => {
    const hop = (entityName: string, column: string, target: string) =>
      db.notes
        .andWhereNode({ via: { column: column as 'id', entity: entityName, target }, where: [] })
        .all();
    expect(await codeOf(() => hop('predicate_node_nobody', 'authorId', 'id'))).toBe(INVALID);
    expect(await codeOf(() => hop('predicate_node_people', 'authorId', 'nope'))).toBe(INVALID);
    // The source's sealing seam answers first, with its own code: a sealed column is no hop key.
    expect(await codeOf(() => hop('predicate_node_people', 'secret', 'id'))).toBe(
      'X_ENTITY_SEALED_PREDICATE',
    );
    const sealedInside = db.people
      .andWhereNode({
        via: { column: 'id', entity: 'predicate_node_notes', target: 'authorId' },
        where: [{ column: 'secret', op: 'eq', value: 'x' }],
      })
      .all();
    expect(await codeOf(() => sealedInside)).toBe(INVALID);
  });

  test('a via built by hand, past readPlan, is refused by the driver — never compiled unscoped', async () => {
    const forged = {
      column: 'authorId',
      op: 'via' as const,
      value: { entity: 'predicate_node_people', target: 'id', where: [] },
    };
    // `findMany` plans it, so it is scoped; the matcher and the compiler refuse an unscoped value.
    const { matchesPredicate } = await import('./memory-match');
    expect(await codeOf(() => matchesPredicate(notes, {}, forged))).toBe(INVALID);
    const { conditions } = await import('./pg-sql');
    const plan = { entity: notes.$name, where: [forged], orderBy: [], limit: 1 };
    expect(await codeOf(() => conditions(notes, plan, { includeDeleted: false }))).toBe(INVALID);
  });
});

describe('andWhereNode — one statement on Postgres', () => {
  test('an or group and a via hop compile into the one select, the hop as a subselect', async () => {
    const client = recordingClient();
    const db = database({ notes, people }, { driver: postgresDriver({ client }) });
    await db.notes
      .andWhereNode({
        or: [
          { column: 'kind', op: 'eq', value: 'a' },
          {
            via: { column: 'authorId', entity: 'predicate_node_people', target: 'id' },
            where: [{ column: 'kind', op: 'eq', value: 'staff' }],
          },
        ],
      })
      .all();
    expect(client.statements).toHaveLength(1);
    const [statement] = client.statements;
    expect(statement?.text).toContain(
      '("kind" = $1 or "author_id" in (select "id" from "predicate_node_people" where "kind" = $2))',
    );
    expect(statement?.values.slice(0, 2)).toEqual(['a', 'staff']);
  });

  test('an empty or is no row in SQL as in memory', async () => {
    const client = recordingClient();
    const db = database({ notes }, { driver: postgresDriver({ client }) });
    await db.notes.andWhereNode({ or: [] }).all();
    expect(client.statements[0]?.text).toContain('1 = 0');
  });
});
