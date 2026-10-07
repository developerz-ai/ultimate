// Issue #687 over a REAL `@ultimat3/entity` table (in-memory driver): a transition's policy decides
// about the row it moves, loaded through the action's own `row` seam, and the compare-and-set
// underneath still runs only when the rule allows it. `transition.test.ts` holds the same seam
// against a fake target; this file holds that a real `Table` and a real read compose with it.

import { afterAll, describe, expect, test } from 'bun:test';
import { ctxOf, UltimateError, userActor } from '@ultimat3/core';
import {
  clearRegistry,
  database,
  entity,
  enumerated,
  memoryDriver,
  text,
  uuid,
} from '@ultimat3/entity';
import { can } from '@ultimat3/policy';
import { type TransitionValues, transition } from './transition';

const STATES = ['draft', 'scheduled'] as const;
type State = (typeof STATES)[number];

const drafts = entity('transition_row_drafts', {
  columns: {
    id: uuid().primaryKey(),
    authorId: text({ max: 40 }),
    status: enumerated(STATES)
      .transitions({ draft: ['scheduled'], scheduled: ['draft'] })
      .default('draft'),
  },
});

afterAll(() => {
  clearRegistry();
});

const ID = '00000000-0000-7000-8000-000000000687';
const db = database({ drafts }, { driver: memoryDriver() });
const as = (id: string) => ctxOf({ actor: { ...userActor({ id }), permissions: ['draft:move'] } });

interface Authored {
  readonly authorId: string;
}

const scheduleDraft = transition({
  table: () => db.drafts,
  column: 'status',
  states: STATES,
  localTable: 'drafts',
  output: drafts.$view(['id', 'status']),
  // The rule reads a column the output view does not carry — which is why the loader is the app's.
  policy: can<TransitionValues<State>, Authored>(
    'draft:move',
    ({ actor, row }) => row !== null && row.authorId === actor?.id,
  ),
  row: ({ input }) => db.drafts.where({ id: input.id }).one(),
}).named('scheduleDraft');

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof UltimateError) return error.code;
    return expect.unreachable('not an UltimateError');
  }
  return expect.unreachable('nothing was refused');
};

describe('transition() with a row loader, over a real table', () => {
  test('another member is refused and the row does not move; its author moves it', async () => {
    await db.drafts.insert({ id: ID, authorId: 'u-author' });
    const move = { id: ID, from: 'draft', to: 'scheduled' } as const;

    expect(await codeOf(() => scheduleDraft(move, { ctx: as('u-other') }))).toBe('X_FORBIDDEN');
    expect((await db.drafts.where({ id: ID }).one())?.status).toBe('draft');

    expect(await scheduleDraft(move, { ctx: as('u-author') })).toEqual({
      id: ID,
      status: 'scheduled',
    });
    expect((await db.drafts.where({ id: ID }).one())?.status).toBe('scheduled');
  });

  test('a row that does not exist is refused by the rule, not answered by the statement', async () => {
    const missing = { id: '00000000-0000-7000-8000-000000000000', from: 'draft', to: 'scheduled' };
    expect(await codeOf(() => scheduleDraft(missing as never, { ctx: as('u-author') }))).toBe(
      'X_FORBIDDEN',
    );
  });
});
