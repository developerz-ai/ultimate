// The fixture, driven the way `@ultimat3/db`'s funnels drive it: `db.statement` events emitted on
// the instrumentation bus. What the funnel then does with a throw from there is
// `fixture-statements-funnel.test.ts`'s; this file pins what the fixture counts, what it lets
// through, and what it hands back on disposal.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { DbStatementEvent, StatementAttribution } from '@ultimat3/core';
import {
  instrument,
  resetInstrumentation,
  subscribe,
  subscribed,
  subscriberCount,
} from '@ultimat3/core';
import { expectedQueryLoop } from '@ultimat3/db';
import {
  clearRegistry,
  entity,
  memoryRepo,
  N_PLUS_ONE_THRESHOLD,
  text,
  uuid,
} from '@ultimat3/entity';
import { type TestStatements, testStatements } from './fixture-statements';
import { runWithFixtures } from './fixtures';

/** Everything a funnel puts on an event that this fixture reads; the rest is fixed. */
interface Sent {
  readonly attribution?: StatementAttribution | undefined;
  readonly expected?: string | undefined;
  readonly error?: unknown;
}

const statement = (text: string, sent: Sent = {}): DbStatementEvent => ({
  text,
  values: [],
  durationMs: 1,
  rows: 1,
  ...sent,
});

const FIND_BY_ID: StatementAttribution = { entity: 'members', op: 'findById' };
const SELECT_ONE = 'select "id" from "members" where "id" = $1';
const INSERT_ONE = 'insert into "members" ("id") values ($1)';

/** Emitted on the bus exactly as a funnel emits, so a test drives what a funnel would. */
const send = (event: DbStatementEvent): void => {
  instrument('db.statement', event);
};

const sendTimes = (times: number, event: DbStatementEvent): void => {
  for (let sent = 0; sent < times; sent += 1) send(event);
};

/** The thrown value, or `undefined` — asserted on directly, so the code is read off the error. */
const caught = (
  run: () => void,
): { readonly code?: string; readonly cause?: string; readonly fix?: string } | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error as { code?: string; cause?: string; fix?: string };
  }
};

// Process-wide, so a fixture left subscribed by a failing assertion would observe every later file.
afterEach(() => {
  resetInstrumentation();
});

describe('unit · the statements fixture measures every statement', () => {
  test('all() keeps them in order and count() answers for one shape or for everything', async () => {
    using statements = await testStatements();
    send(statement(SELECT_ONE, { attribution: FIND_BY_ID }));
    send(statement(INSERT_ONE));

    expect(statements.count()).toBe(2);
    expect(statements.count('members.findById')).toBe(1);
    expect(statements.count('nothing.likeThis')).toBe(0);
    expect(statements.all().map((entry) => entry.fingerprint)).toEqual([
      'members.findById',
      INSERT_ONE,
    ]);
    expect(statements.all()[0]?.attribution).toEqual(FIND_BY_ID);
    expect(statements.all()[0]?.text).toBe(SELECT_ONE);
  });

  test('one shape is one entity.op when attributed, its own collapsed text when it is not', async () => {
    using statements = await testStatements();
    send(statement('select "id"\n  from "members"'));
    send(statement('select "id" from "members"'));
    send(statement(SELECT_ONE, { attribution: FIND_BY_ID }));
    send(statement('select 1 from "posts"', { attribution: FIND_BY_ID }));

    expect(statements.shapes()).toEqual([
      { fingerprint: 'members.findById', kind: 'read', count: 2 },
      { fingerprint: 'select "id" from "members"', kind: 'read', count: 2 },
    ]);
  });

  test('the verb decides the kind: a CTE reads, an insert writes', async () => {
    using statements = await testStatements();
    const cte = 'with recent as (select 1) select * from recent';
    send(statement(cte));
    send(statement(INSERT_ONE));

    const kinds = Object.fromEntries(
      statements.shapes().map((shape) => [shape.fingerprint, shape.kind]),
    );
    expect(kinds[cte]).toBe('read');
    expect(kinds[INSERT_ONE]).toBe('write');
  });

  test('shapes() puts the most repeated first, and ties read in fingerprint order', async () => {
    using statements = await testStatements();
    sendTimes(2, statement('select b'));
    send(statement('select c'));
    send(statement('select a'));

    expect(statements.shapes().map((shape) => shape.fingerprint)).toEqual([
      'select b',
      'select a',
      'select c',
    ]);
  });
});

/** Disposal raises the first verdict: the code, cause and fix are read off what it threw. */
const verdictOf = (statements: TestStatements): ReturnType<typeof caught> =>
  caught(() => statements[Symbol.dispose]());

describe('unit · a shape past the threshold fails the test it happened in', () => {
  test('one under the threshold is quiet; the one that crosses it is the verdict', async () => {
    const statements = await testStatements();
    sendTimes(N_PLUS_ONE_THRESHOLD - 1, statement(SELECT_ONE, { attribution: FIND_BY_ID }));
    expect(statements.verdicts()).toEqual([]);

    // The bus contains a subscriber's throw, so the statement itself never fails: the verdict is
    // recorded where the shape crossed, and raised at disposal.
    expect(caught(() => send(statement(SELECT_ONE, { attribution: FIND_BY_ID })))).toBeUndefined();
    expect(statements.count('members.findById')).toBe(N_PLUS_ONE_THRESHOLD);
    expect(statements.verdicts().map((error) => error.code)).toEqual(['X_N_PLUS_ONE_QUERY']);
    expect(verdictOf(statements)?.code).toBe('X_N_PLUS_ONE_QUERY');
  });

  test('the error names the shape, its count and the entity the loop repeated on', async () => {
    const statements = await testStatements();
    sendTimes(N_PLUS_ONE_THRESHOLD, statement(SELECT_ONE, { attribution: FIND_BY_ID }));

    const error = verdictOf(statements);
    expect(error?.code).toBe('X_N_PLUS_ONE_QUERY');
    expect(error?.cause).toContain('members.findById');
    expect(error?.cause).toContain(String(N_PLUS_ONE_THRESHOLD));
    // No relation in this process points at `members`, so the fix is the `in` form rather than a
    // preload the schema never declared. Which fix a schema earns is `@ultimat3/entity`'s.
    expect(error?.fix).toContain('members');
  });

  test('a repeated single-row write is the write code, not the read one', async () => {
    const statements = await testStatements();
    sendTimes(N_PLUS_ONE_THRESHOLD, statement(INSERT_ONE));

    expect(verdictOf(statements)?.code).toBe('X_N_PLUS_ONE_WRITE');
  });

  test('a statement that threw is still a statement', async () => {
    const statements = await testStatements();
    const failed = statement(SELECT_ONE, { attribution: FIND_BY_ID, error: new Error('timeout') });
    sendTimes(N_PLUS_ONE_THRESHOLD, failed);

    expect(statements.count('members.findById')).toBe(N_PLUS_ONE_THRESHOLD);
    expect(verdictOf(statements)?.code).toBe('X_N_PLUS_ONE_QUERY');
  });

  test('a shape is one verdict however long the loop runs, and the count is the whole loop', async () => {
    const statements = await testStatements();
    sendTimes(N_PLUS_ONE_THRESHOLD + 3, statement(SELECT_ONE, { attribution: FIND_BY_ID }));

    expect(statements.verdicts()).toHaveLength(1);
    expect(statements.count('members.findById')).toBe(N_PLUS_ONE_THRESHOLD + 3);
    expect(statements.shapes()[0]?.count).toBe(N_PLUS_ONE_THRESHOLD + 3);
    expect(verdictOf(statements)).toBeDefined();
  });

  // The verdict is built inside the subscriber, which the bus calls synchronously on the
  // statement's own stack — so the error raised at teardown still points at the looping line.
  test('the verdict raised at teardown carries the stack of the statement that crossed', async () => {
    const statements = await testStatements();
    function loopsOverMembers(): void {
      sendTimes(N_PLUS_ONE_THRESHOLD, statement(SELECT_ONE, { attribution: FIND_BY_ID }));
    }
    loopsOverMembers();

    const error = verdictOf(statements) as { readonly stack?: string } | undefined;
    expect(error?.stack).toContain('loopsOverMembers');
  });

  test('disposal raises the verdict once, so a second dispose is quiet', async () => {
    const statements = await testStatements();
    sendTimes(N_PLUS_ONE_THRESHOLD, statement(SELECT_ONE, { attribution: FIND_BY_ID }));

    expect(verdictOf(statements)?.code).toBe('X_N_PLUS_ONE_QUERY');
    expect(verdictOf(statements)).toBeUndefined();
  });

  test('two shapes are two verdicts, in the order they crossed; disposal raises the first', async () => {
    const statements = await testStatements();
    sendTimes(N_PLUS_ONE_THRESHOLD, statement(SELECT_ONE, { attribution: FIND_BY_ID }));
    sendTimes(N_PLUS_ONE_THRESHOLD, statement(INSERT_ONE));

    expect(statements.verdicts().map((error) => error.code)).toEqual([
      'X_N_PLUS_ONE_QUERY',
      'X_N_PLUS_ONE_WRITE',
    ]);
    expect(verdictOf(statements)?.code).toBe('X_N_PLUS_ONE_QUERY');
  });
});

describe('unit · an expected loop is measured and never judged', () => {
  test('a declared loop is never a verdict, however long it runs', async () => {
    using statements = await testStatements();
    const expected = statement(SELECT_ONE, {
      attribution: FIND_BY_ID,
      expected: 'one indexed lookup per searchable field',
    });

    sendTimes(N_PLUS_ONE_THRESHOLD * 2, expected);
    expect(statements.verdicts()).toEqual([]);
    // Still counted: `count()` measures, and a test asserting "this page issues N statements" must
    // not read a different number because somebody declared the loop deliberate.
    expect(statements.count('members.findById')).toBe(N_PLUS_ONE_THRESHOLD * 2);
    expect(statements.all()[0]?.expected).toBe('one indexed lookup per searchable field');
  });

  test('only the undeclared statements of a shape count toward its verdict', async () => {
    const statements = await testStatements();
    sendTimes(
      N_PLUS_ONE_THRESHOLD,
      statement(SELECT_ONE, { attribution: FIND_BY_ID, expected: 'seeding' }),
    );
    sendTimes(N_PLUS_ONE_THRESHOLD - 1, statement(SELECT_ONE, { attribution: FIND_BY_ID }));
    expect(statements.verdicts()).toEqual([]);

    send(statement(SELECT_ONE, { attribution: FIND_BY_ID }));
    expect(verdictOf(statements)?.code).toBe('X_N_PLUS_ONE_QUERY');
  });
});

describe('unit · the fixture releases its subscription', () => {
  test('disposal unsubscribes, and nothing after the test is counted', async () => {
    const statements = await testStatements();
    send(statement(SELECT_ONE));
    statements[Symbol.dispose]();
    send(statement(SELECT_ONE));

    expect(subscribed('db.statement')).toBe(false);
    expect(statements.count()).toBe(1);
  });

  test('a subscriber added before the test keeps hearing every statement, beside the fixture', async () => {
    const seen: string[] = [];
    const off = subscribe('db.statement', (event) => void seen.push(event.payload.text));

    const statements = await testStatements();
    send(statement(SELECT_ONE));
    expect(seen).toEqual([SELECT_ONE]);
    expect(statements.count()).toBe(1);

    statements[Symbol.dispose]();
    expect(subscribed('db.statement')).toBe(true);
    off();
  });

  test('the registered fixture is subscribed for the body and gone after it', async () => {
    const before = subscriberCount();
    let inside = false;
    await runWithFixtures(async ({ statements }) => {
      inside = subscribed('db.statement');
      expect(statements.count()).toBe(0);
    });

    expect(inside).toBe(true);
    expect(subscriberCount()).toBe(before);
  });

  test('a body that loops fails, and the fixture is still disposed', async () => {
    const run = runWithFixtures(async ({ statements }) => {
      sendTimes(N_PLUS_ONE_THRESHOLD, statement(SELECT_ONE, { attribution: FIND_BY_ID }));
      expect(statements.count()).toBe(N_PLUS_ONE_THRESHOLD);
    });

    await expect(run).rejects.toMatchObject({ code: 'X_N_PLUS_ONE_QUERY' });
    expect(subscribed('db.statement')).toBe(false);
  });
});

describe('unit · the verdict holds on the memory driver, where generated tests run', () => {
  const members = entity('fixture_memory_members', {
    columns: { id: uuid().primaryKey(), name: text({ max: 40 }) },
  });
  const IDS = Array.from(
    { length: N_PLUS_ONE_THRESHOLD + 3 },
    (_unused, at) => `00000000-0000-4000-8000-${String(at).padStart(12, '0')}`,
  );

  afterAll(() => {
    clearRegistry();
  });

  test('a findById loop is X_N_PLUS_ONE_QUERY, attributed to the loop own lookup', async () => {
    const statements = await testStatements();
    const repo = memoryRepo(members);
    for (const id of IDS) await repo.findById(id);
    expect(statements.count('fixture_memory_members.findById')).toBe(IDS.length);
    expect(verdictOf(statements)).toBeUltimateError('X_N_PLUS_ONE_QUERY');
  });

  test('the verdict points at the loop in the test, not at the driver', async () => {
    const statements = await testStatements();
    const repo = memoryRepo(members);
    for (const id of IDS) await repo.findById(id);
    const error = verdictOf(statements) as { readonly stack?: string } | undefined;
    expect(error?.stack).toContain('fixture-statements.test.ts:');
    // The sender's stack, not the subscriber's that built the error.
    expect(error?.stack).not.toContain('fixture-statements.ts:');
  });

  test('a write loop is X_N_PLUS_ONE_WRITE', async () => {
    const statements = await testStatements();
    const repo = memoryRepo(members);
    for (const id of IDS) await repo.insert({ id, name: 'a' });
    expect(verdictOf(statements)).toBeUltimateError('X_N_PLUS_ONE_WRITE');
  });

  test('expectedQueryLoop still suppresses the verdict, and never the measurement', async () => {
    using statements = await testStatements();
    const repo = memoryRepo(members);
    await expectedQueryLoop('a fixed set of lookups a test names on purpose', async () => {
      for (const id of IDS) await repo.findById(id);
    });
    expect(statements.count('fixture_memory_members.findById')).toBe(IDS.length);
  });
});
