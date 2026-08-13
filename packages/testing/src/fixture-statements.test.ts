// The fixture, driven the way `@ultimat3/db`'s funnels drive it: `StatementEvent`s handed to the
// installed `observer.onStatement`. What the funnel then does with a throw from there is
// `fixture-statements-funnel.test.ts`'s; this file pins what the fixture counts, what it lets
// through, and what it hands back on disposal.

import { afterEach, describe, expect, test } from 'bun:test';
import type { StatementAttribution, StatementEvent, StatementObserver } from '@ultimat3/db';
import { setStatementObserver, statementObserver } from '@ultimat3/db';
import { N_PLUS_ONE_THRESHOLD } from '@ultimat3/entity';
import { createTestStatements } from './fixture-statements';
import { runWithFixtures } from './fixtures';

/** Everything a funnel puts on an event that this fixture reads; the rest is fixed. */
interface Sent {
  readonly attribution?: StatementAttribution | undefined;
  readonly expected?: string | undefined;
  readonly error?: unknown;
}

const statement = (text: string, sent: Sent = {}): StatementEvent => ({
  text,
  values: [],
  durationMs: 1,
  rows: 1,
  ...sent,
});

const FIND_BY_ID: StatementAttribution = { entity: 'members', op: 'findById' };
const SELECT_ONE = 'select "id" from "members" where "id" = $1';
const INSERT_ONE = 'insert into "members" ("id") values ($1)';

/** The seam the fixture installed into, so a test drives exactly what a funnel would. */
const send = (event: StatementEvent): void => {
  const observer = statementObserver();
  if (observer === undefined) throw new Error('the fixture installed no observer');
  observer.onStatement(event);
};

const sendTimes = (times: number, event: StatementEvent): void => {
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

// Process-wide, so a fixture left installed by a failing assertion would observe every later file.
afterEach(() => {
  setStatementObserver(undefined);
});

describe('unit · the statements fixture measures every statement', () => {
  test('all() keeps them in order and count() answers for one shape or for everything', async () => {
    using statements = await createTestStatements();
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
    using statements = await createTestStatements();
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
    using statements = await createTestStatements();
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
    using statements = await createTestStatements();
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

describe('unit · a shape past the threshold fails the test it happened in', () => {
  test('one under the threshold is quiet; the one that crosses it throws', async () => {
    using statements = await createTestStatements();
    sendTimes(N_PLUS_ONE_THRESHOLD - 1, statement(SELECT_ONE, { attribution: FIND_BY_ID }));

    expect(statements.count('members.findById')).toBe(N_PLUS_ONE_THRESHOLD - 1);
    expect(caught(() => send(statement(SELECT_ONE, { attribution: FIND_BY_ID })))?.code).toBe(
      'X_N_PLUS_ONE_QUERY',
    );
  });

  test('the error names the shape, its count and the entity the loop repeated on', async () => {
    using _statements = await createTestStatements();
    sendTimes(N_PLUS_ONE_THRESHOLD - 1, statement(SELECT_ONE, { attribution: FIND_BY_ID }));

    const error = caught(() => send(statement(SELECT_ONE, { attribution: FIND_BY_ID })));
    expect(error?.code).toBe('X_N_PLUS_ONE_QUERY');
    expect(error?.cause).toContain('members.findById');
    expect(error?.cause).toContain(String(N_PLUS_ONE_THRESHOLD));
    // No relation in this process points at `members`, so the fix is the `in` form rather than a
    // preload the schema never declared. Which fix a schema earns is `@ultimat3/entity`'s.
    expect(error?.fix).toContain('members');
  });

  test('a repeated single-row write is the write code, not the read one', async () => {
    using _statements = await createTestStatements();
    sendTimes(N_PLUS_ONE_THRESHOLD - 1, statement(INSERT_ONE));

    expect(caught(() => send(statement(INSERT_ONE)))?.code).toBe('X_N_PLUS_ONE_WRITE');
  });

  test('a statement that threw is still a statement', async () => {
    using statements = await createTestStatements();
    const failed = statement(SELECT_ONE, { attribution: FIND_BY_ID, error: new Error('timeout') });
    sendTimes(N_PLUS_ONE_THRESHOLD - 1, failed);

    expect(caught(() => send(failed))?.code).toBe('X_N_PLUS_ONE_QUERY');
    expect(statements.count('members.findById')).toBe(N_PLUS_ONE_THRESHOLD);
  });

  test('a shape throws once and keeps counting, so a swallowed failure is still reported', async () => {
    using statements = await createTestStatements();
    sendTimes(N_PLUS_ONE_THRESHOLD - 1, statement(SELECT_ONE, { attribution: FIND_BY_ID }));
    expect(caught(() => send(statement(SELECT_ONE, { attribution: FIND_BY_ID })))).toBeDefined();

    // The loop that swallowed it keeps running: no second throw, and the count is the whole loop.
    expect(
      caught(() => sendTimes(3, statement(SELECT_ONE, { attribution: FIND_BY_ID }))),
    ).toBeUndefined();
    expect(statements.count('members.findById')).toBe(N_PLUS_ONE_THRESHOLD + 3);
    expect(statements.shapes()[0]?.count).toBe(N_PLUS_ONE_THRESHOLD + 3);
  });

  test('two shapes are two verdicts: one throwing does not silence the other', async () => {
    using _statements = await createTestStatements();
    caught(() =>
      sendTimes(N_PLUS_ONE_THRESHOLD, statement(SELECT_ONE, { attribution: FIND_BY_ID })),
    );

    expect(caught(() => sendTimes(N_PLUS_ONE_THRESHOLD, statement(INSERT_ONE)))?.code).toBe(
      'X_N_PLUS_ONE_WRITE',
    );
  });
});

describe('unit · an expected loop is measured and never judged', () => {
  test('a declared loop never throws, however long it runs', async () => {
    using statements = await createTestStatements();
    const expected = statement(SELECT_ONE, {
      attribution: FIND_BY_ID,
      expected: 'one indexed lookup per searchable field',
    });

    expect(caught(() => sendTimes(N_PLUS_ONE_THRESHOLD * 2, expected))).toBeUndefined();
    // Still counted: `count()` measures, and a test asserting "this page issues N statements" must
    // not read a different number because somebody declared the loop deliberate.
    expect(statements.count('members.findById')).toBe(N_PLUS_ONE_THRESHOLD * 2);
    expect(statements.all()[0]?.expected).toBe('one indexed lookup per searchable field');
  });

  test('only the undeclared statements of a shape count toward its verdict', async () => {
    using _statements = await createTestStatements();
    sendTimes(
      N_PLUS_ONE_THRESHOLD,
      statement(SELECT_ONE, { attribution: FIND_BY_ID, expected: 'seeding' }),
    );
    sendTimes(N_PLUS_ONE_THRESHOLD - 1, statement(SELECT_ONE, { attribution: FIND_BY_ID }));

    expect(caught(() => send(statement(SELECT_ONE, { attribution: FIND_BY_ID })))?.code).toBe(
      'X_N_PLUS_ONE_QUERY',
    );
  });
});

describe('unit · the fixture hands the seam back', () => {
  test('disposal uninstalls it, and nothing after the test is counted', async () => {
    const statements = await createTestStatements();
    send(statement(SELECT_ONE));
    statements[Symbol.dispose]();

    expect(statementObserver()).toBeUndefined();
    expect(statements.count()).toBe(1);
  });

  test('an observer installed before the test is displaced, then put back', async () => {
    const seen: string[] = [];
    const outer: StatementObserver = {
      onStatement: (event) => {
        seen.push(event.text);
      },
    };
    setStatementObserver(outer);

    const statements = await createTestStatements();
    send(statement(SELECT_ONE));
    expect(seen).toEqual([]);

    statements[Symbol.dispose]();
    expect(statementObserver()).toBe(outer);
  });

  test('the registered fixture is installed for the body and gone after it', async () => {
    let inside: StatementObserver | undefined;
    await runWithFixtures(async ({ statements }) => {
      inside = statementObserver();
      expect(statements.count()).toBe(0);
    });

    expect(inside).toBeDefined();
    expect(statementObserver()).toBeUndefined();
  });

  test('a body that loops fails, and the fixture is still disposed', async () => {
    const run = runWithFixtures(async ({ statements }) => {
      sendTimes(N_PLUS_ONE_THRESHOLD, statement(SELECT_ONE, { attribution: FIND_BY_ID }));
      expect(statements.count()).toBe(N_PLUS_ONE_THRESHOLD);
    });

    await expect(run).rejects.toMatchObject({ code: 'X_N_PLUS_ONE_QUERY' });
    expect(statementObserver()).toBeUndefined();
  });
});
