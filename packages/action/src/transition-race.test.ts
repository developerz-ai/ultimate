// Issue #702 through the whole factory: the `row` loader reads, the policy decides, and only then
// does the compare-and-set run — so a reassignment landing between the read and the move used to be
// moved anyway, on a decision about a row that no longer existed. The race is injected inside the
// loader, after its read, which is exactly the window: deterministic, no timers.

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
import { type TransitionTarget, type TransitionValues, transition } from './transition';

const STATES = ['draft', 'published'] as const;
type State = (typeof STATES)[number];

const posts = entity('transition_race_posts', {
  columns: {
    id: uuid().primaryKey(),
    authorId: text({ max: 40 }),
    title: text({ max: 80 }),
    status: enumerated(STATES)
      .transitions({ draft: ['published'], published: [] })
      .default('draft'),
  },
});

afterAll(() => {
  clearRegistry();
});

const ID = '00000000-0000-7000-8000-000000000702';
const as = (id: string) =>
  ctxOf({ actor: { ...userActor({ id }), permissions: ['post:publish'] } });
const MOVE = { id: ID, from: 'draft', to: 'published' } as const;

interface Authored {
  readonly authorId: string;
}

/** A publish whose loader lets `between` run after its read — the concurrent writer. */
const publishWith = (
  db: ReturnType<typeof database<{ posts: typeof posts }>>,
  between: () => Promise<unknown>,
  table: () => TransitionTarget<typeof posts.$row, State> = () => db.posts,
) =>
  transition({
    table,
    column: 'status',
    states: STATES,
    localTable: 'posts',
    output: posts.$view(['id', 'status']),
    policy: can<TransitionValues<State>, Authored>(
      'post:publish',
      ({ actor, row }) => row !== null && row.authorId === actor?.id,
    ),
    row: async ({ input }) => {
      const read = await db.posts.where({ id: input.id }).one();
      await between();
      return read;
    },
  }).named('publishPost');

const outcome = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'moved';
  } catch (error) {
    if (error instanceof UltimateError) return error.code;
    return expect.unreachable('not an UltimateError');
  }
};

describe('transition({ row }) — the decision rides in the compare-and-set (#702)', () => {
  test('a reassignment between the read and the move is refused, and the row does not move', async () => {
    const db = database({ posts }, { driver: memoryDriver() });
    await db.posts.insert({ id: ID, authorId: 'u-author', title: 'a' });
    const publish = publishWith(db, () => db.posts.update(ID, { authorId: 'u-new-owner' }));

    expect(await outcome(() => publish(MOVE, { ctx: as('u-author') }))).toBe('X_STATE_CONFLICT');
    const after = await db.posts.where({ id: ID }).one();
    expect(after?.status).toBe('draft');
    expect(after?.authorId).toBe('u-new-owner');
  });

  test('a concurrent write to a column the rule never read does not refuse the move', async () => {
    const db = database({ posts }, { driver: memoryDriver() });
    await db.posts.insert({ id: ID, authorId: 'u-author', title: 'a' });
    const publish = publishWith(db, () => db.posts.update(ID, { title: 'retitled' }));

    expect(await outcome(() => publish(MOVE, { ctx: as('u-author') }))).toBe('moved');
    expect((await db.posts.where({ id: ID }).one())?.status).toBe('published');
  });

  test('the target is handed the loaded row and exactly what the rule read', async () => {
    const db = database({ posts }, { driver: memoryDriver() });
    const stored = await db.posts.insert({ id: ID, authorId: 'u-author', title: 'a' });
    const seen: unknown[] = [];
    const spy: TransitionTarget<typeof posts.$row, State> = {
      transition: async (column, id, move) => {
        seen.push(move.observed);
        return db.posts.transition(column as 'status', id, move);
      },
    };
    const publish = publishWith(
      db,
      async () => undefined,
      () => spy,
    );

    expect(await outcome(() => publish(MOVE, { ctx: as('u-author') }))).toBe('moved');
    // The raw row — never the recording view the rule was handed — and only the column it read.
    expect(seen).toEqual([{ row: stored, read: ['authorId'] }]);
  });
});
