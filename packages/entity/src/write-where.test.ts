// The plan a filtered write runs — `updateWhere`/`deleteWhere` and the chain's `updateAll()`/
// `deleteAll()` alike — and the chain shapes a write refuses. Driver-free: every driver executes the
// plan built here, so what it holds is what all of them write.

import { describe, expect, test } from 'bun:test';
import { text, timestamp, uuid } from './columns';
import { entity } from './entity';
import type { Predicate } from './tenancy';
import {
  assertWritableChain,
  predicateColumns,
  updateWherePlan,
  writeWherePlan,
} from './write-where';

const likes = entity('ww_likes', {
  columns: { postId: uuid(), userId: uuid(), note: text().nullable() },
  primaryKey: ['postId', 'userId'],
});

const notes = entity('ww_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    body: text(),
    archivedAt: timestamp().nullable(),
  },
});

const ORG = '00000000-0000-7000-8000-0000000000a1';
const POST = '00000000-0000-7000-8000-0000000003a1';
const USERS = ['00000000-0000-7000-8000-0000000004a1', '00000000-0000-7000-8000-0000000004b1'];

const inUsers: Predicate = { column: 'userId', op: 'in', value: USERS };

describe('writeWherePlan', () => {
  test('a filter is its equalities, an undefined value dropped rather than bound', () => {
    const plan = writeWherePlan(
      likes,
      { postId: POST, userId: undefined },
      undefined,
      'deleteWhere',
    );
    expect(plan.where).toEqual([{ column: 'postId', op: 'eq', value: POST }]);
  });

  test('a chain predicate rides beside the filter, any operator', () => {
    const plan = writeWherePlan(likes, { postId: POST }, { where: [inUsers] }, 'deleteWhere');
    expect(plan.where).toEqual([{ column: 'postId', op: 'eq', value: POST }, inUsers]);
  });

  test('an empty filter is refused, spelled as the call that was written', () => {
    let filtered: unknown;
    try {
      writeWherePlan(likes, {}, undefined, 'deleteWhere');
    } catch (error) {
      filtered = error;
    }
    expect(filtered).toBeUltimateError('X_WRITE_UNFILTERED');
    expect(String((filtered as { fix: string }).fix)).toContain('ww_likes.deleteWhere({ postId');

    let chained: unknown;
    try {
      writeWherePlan(likes, {}, { where: [] }, 'deleteWhere');
    } catch (error) {
      chained = error;
    }
    expect(chained).toBeUltimateError('X_WRITE_UNFILTERED');
    expect(String((chained as { fix: string }).fix)).toContain(
      'ww_likes.where({ postId, userId }).deleteAll()',
    );
  });

  test('a chain predicate with an undefined value is refused, even beside one that bounds it', () => {
    let refused: unknown;
    try {
      writeWherePlan(
        likes,
        {},
        {
          where: [
            { column: 'postId', op: 'eq', value: POST },
            { column: 'userId', op: 'eq', value: undefined },
          ],
        },
        'deleteWhere',
      );
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeUltimateError('X_WRITE_UNFILTERED');
    expect(String((refused as { cause: string }).cause)).toContain('userId');
    expect(String((refused as { fix: string }).fix)).toContain(
      'ww_likes.where({ userId }).deleteAll()',
    );
    // An `in` with no list is the same bug.
    expect(() =>
      writeWherePlan(likes, {}, { where: [{ ...inUsers, value: undefined }] }, 'updateWhere'),
    ).toThrow(expect.objectContaining({ code: 'X_WRITE_UNFILTERED' }));
  });

  test('the FILTER keeps dropping an undefined value: updateWhere is unchanged', () => {
    const plan = writeWherePlan(
      likes,
      { postId: POST, userId: undefined },
      undefined,
      'updateWhere',
    );
    expect(plan.where).toEqual([{ column: 'postId', op: 'eq', value: POST }]);
  });

  test('a NULL test carries no value and is still a filter', () => {
    const where: Predicate[] = [{ column: 'archivedAt', op: 'is-null' }];
    const plan = writeWherePlan(notes, {}, { where, orgId: ORG }, 'deleteWhere');
    expect(plan.where).toEqual([...where, { column: 'orgId', op: 'eq', value: ORG }]);
  });

  test('scoped exactly as a read: no tenant is refused, and the empty filter is refused first', () => {
    expect(() => writeWherePlan(notes, {}, { where: [inUsers] }, 'deleteWhere')).toThrow(
      expect.objectContaining({ code: 'X_TENANCY_UNSCOPED' }),
    );
    // The org predicate the framework adds is not a filter the caller named.
    expect(() => writeWherePlan(notes, {}, { where: [], orgId: ORG }, 'deleteWhere')).toThrow(
      expect.objectContaining({ code: 'X_WRITE_UNFILTERED' }),
    );
  });

  test('an operator no driver can answer is refused at the plan, as on the read path', () => {
    const where = [{ column: 'postId', op: 'near', value: POST } as unknown as Predicate];
    expect(() => writeWherePlan(likes, {}, { where }, 'deleteWhere')).toThrow(
      expect.objectContaining({ code: 'X_ENTITY_OPERATOR_UNKNOWN' }),
    );
  });
});

describe('updateWherePlan', () => {
  test('an empty patch is refused after the filter, in the spelling written', () => {
    let chained: unknown;
    try {
      updateWherePlan(likes, {}, { note: undefined }, { where: [inUsers] }, 'updateWhere');
    } catch (error) {
      chained = error;
    }
    expect(chained).toBeUltimateError('X_PATCH_EMPTY');
    expect(String((chained as { fix: string }).fix)).toContain('.updateAll({ <column>: <value> })');
    expect(() => updateWherePlan(likes, {}, { note: 'x' }, { where: [] }, 'updateWhere')).toThrow(
      expect.objectContaining({ code: 'X_WRITE_UNFILTERED' }),
    );
  });

  test('a named patch and a bounded chain plan the chain predicates', () => {
    const plan = updateWherePlan(likes, {}, { note: 'x' }, { where: [inUsers] }, 'updateWhere');
    expect(plan.where).toEqual([inUsers]);
  });
});

describe('assertWritableChain', () => {
  const bounded = { where: [inUsers], limit: undefined, cursor: null };

  test('a bounded chain with no page writes', () => {
    expect(() => assertWritableChain('ww_likes', 'deleteAll', bounded)).not.toThrow();
  });

  test('a page size is refused: no driver can delete or update only the first n rows', () => {
    expect(() => assertWritableChain('ww_likes', 'deleteAll', { ...bounded, limit: 5 })).toThrow(
      expect.objectContaining({ code: 'X_INVARIANT_VIOLATED' }),
    );
  });

  test('a cursor is refused: the rows before it would be written too', () => {
    expect(() => assertWritableChain('ww_likes', 'updateAll', { ...bounded, cursor: 'c' })).toThrow(
      expect.objectContaining({ code: 'X_INVARIANT_VIOLATED' }),
    );
  });

  test('a search is refused: an external index answers a bounded sample', () => {
    const where: Predicate[] = [...bounded.where, { column: '$search', op: 'matches', value: 'x' }];
    expect(() => assertWritableChain('ww_likes', 'deleteAll', { ...bounded, where })).toThrow(
      expect.objectContaining({ code: 'X_INVARIANT_VIOLATED' }),
    );
  });
});

test('predicateColumns names every column a filtered write is bounded by', () => {
  expect(predicateColumns({ postId: POST, note: undefined }, [inUsers])).toEqual([
    'postId',
    'userId',
  ]);
  expect(predicateColumns(undefined, undefined)).toEqual([]);
});
