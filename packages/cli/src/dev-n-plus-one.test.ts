// The ledger, driven the way `@ultimat3/db`'s funnels drive it: `StatementEvent`s handed to
// `observer.onStatement` from inside a real `runWithContext` scope. The context half is the real
// one on purpose — "per request" is the whole mechanism, and a fake context would prove a tally
// nothing in a running process keys the same way.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { createContext, logger, runWithContext } from '@ultimat3/core';
import type { StatementAttribution, StatementEvent } from '@ultimat3/db';
import { createStatementLedger, DEFAULT_REPEAT_THRESHOLD } from './dev-n-plus-one';

/** Everything a funnel puts on an event that this ledger reads; the rest is fixed. */
interface Sent {
  readonly attribution?: StatementAttribution | undefined;
  readonly expected?: string | undefined;
  readonly error?: unknown;
  readonly rows?: number | undefined;
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

/** One request, one context — the unit the threshold is counted over. */
function request<T>(fn: (ctx: Ctx) => T): T {
  const ctx = createContext({});
  return runWithContext(ctx, () => fn(ctx));
}

// Every promotion emits a line, so the whole file captures rather than printing a wall of JSON at
// whoever runs the suite; the tests that assert ON the lines read this same array. Installed and
// restored per test, never once at module scope — `bun test` runs this file in the same process as
// its neighbours, and a patched logger left behind is their problem, not this file's.
const warnings: string[] = [];
let printWarning = logger.warn;

beforeEach(() => {
  printWarning = logger.warn;
  warnings.length = 0;
  logger.warn = (line: string): void => {
    warnings.push(line);
  };
});

afterEach(() => {
  logger.warn = printWarning;
});

describe('unit · the N+1 ledger counts one shape per request', () => {
  test('four of a shape is four reads; the fifth is the loop', () => {
    const ledger = createStatementLedger();
    request(() => {
      for (let sent = 0; sent < DEFAULT_REPEAT_THRESHOLD - 1; sent += 1) {
        ledger.observer.onStatement(statement(SELECT_ONE));
      }
    });
    expect(ledger.repeats()).toEqual([]);

    request(() => {
      for (let sent = 0; sent < DEFAULT_REPEAT_THRESHOLD; sent += 1) {
        ledger.observer.onStatement(statement(SELECT_ONE));
      }
    });
    expect(ledger.repeats()).toHaveLength(1);
    expect(ledger.repeats()[0]?.count).toBe(DEFAULT_REPEAT_THRESHOLD);
  });

  // A verdict per statement past the threshold would report a loop of fifty forty-six times, and
  // one frozen at the threshold would report it as five.
  test('a loop of fifty is one verdict reading fifty, not forty-six verdicts', () => {
    const ledger = createStatementLedger();
    request(() => {
      for (let sent = 0; sent < 50; sent += 1) ledger.observer.onStatement(statement(SELECT_ONE));
    });
    expect(ledger.repeats()).toHaveLength(1);
    expect(ledger.repeats()[0]?.count).toBe(50);
  });

  test('the verdict names the request it happened in', () => {
    const ledger = createStatementLedger({ threshold: 2 });
    const ctx = createContext({ requestId: 'req_7' });
    runWithContext(ctx, () => {
      ledger.observer.onStatement(statement(SELECT_ONE));
      ledger.observer.onStatement(statement(SELECT_ONE));
    });
    expect(ledger.repeats()[0]?.requestId).toBe('req_7');
    expect(ledger.repeats()[0]?.traceId).toBe(ctx.traceId);
  });

  // Keying the tally globally is the obvious wrong implementation: eight statements across two
  // requests would then trip a threshold neither request reached.
  test('a shape repeated across two requests is two tallies, not one', () => {
    const ledger = createStatementLedger();
    for (let visit = 0; visit < 2; visit += 1) {
      request(() => {
        for (let sent = 0; sent < DEFAULT_REPEAT_THRESHOLD - 1; sent += 1) {
          ledger.observer.onStatement(statement(SELECT_ONE));
        }
      });
    }
    expect(ledger.repeats()).toEqual([]);
  });

  test('two shapes in one request are counted apart', () => {
    const ledger = createStatementLedger({ threshold: 3 });
    request(() => {
      for (let sent = 0; sent < 3; sent += 1) {
        ledger.observer.onStatement(statement(SELECT_ONE));
        ledger.observer.onStatement(statement('select "id" from "posts" where "id" = $1'));
      }
      ledger.observer.onStatement(statement('select count(*) from "posts"'));
    });
    expect(ledger.repeats().map((repeat) => repeat.count)).toEqual([3, 3]);
  });

  // A migration, a boot probe, a script: no request means no unit for "five of one shape" to be
  // five of. Counting them would make `x dev`'s own startup the first loop it reports.
  test('a statement issued outside a request is not counted at all', () => {
    const ledger = createStatementLedger();
    for (let sent = 0; sent < 20; sent += 1) ledger.observer.onStatement(statement(SELECT_ONE));
    expect(ledger.repeats()).toEqual([]);
  });

  test('a snapshot does not move under its reader while the request keeps going', () => {
    const ledger = createStatementLedger({ threshold: 2 });
    request(() => {
      ledger.observer.onStatement(statement(SELECT_ONE));
      ledger.observer.onStatement(statement(SELECT_ONE));
      const taken = ledger.repeats();
      ledger.observer.onStatement(statement(SELECT_ONE));
      expect(taken[0]?.count).toBe(2);
      expect(ledger.repeats()[0]?.count).toBe(3);
    });
  });
});

describe('unit · the fingerprint is what the author can act on', () => {
  // The whole point of `withStatementAttribution`: fifty point lookups compiled from fifty ids are
  // one report about `findById`, not fifty rows of SQL that differ only in a bind value.
  test('an attributed statement groups by entity and operation, not by its SQL', () => {
    const ledger = createStatementLedger();
    request(() => {
      for (let sent = 0; sent < DEFAULT_REPEAT_THRESHOLD; sent += 1) {
        ledger.observer.onStatement(
          statement(`select "id" from "members" where "id" = $1 /* ${sent} */`, {
            attribution: FIND_BY_ID,
          }),
        );
      }
    });
    const [repeat] = ledger.repeats();
    expect(repeat?.fingerprint).toBe('members.findById');
    expect(repeat?.attribution).toEqual(FIND_BY_ID);
    expect(repeat?.sample).toContain('from "members"');
  });

  test('two operations on one entity are two shapes', () => {
    const ledger = createStatementLedger({ threshold: 2 });
    request(() => {
      for (let sent = 0; sent < 2; sent += 1) {
        ledger.observer.onStatement(statement(SELECT_ONE, { attribution: FIND_BY_ID }));
        ledger.observer.onStatement(
          statement(SELECT_ONE, { attribution: { entity: 'members', op: 'count' } }),
        );
      }
    });
    expect(
      ledger
        .repeats()
        .map((repeat) => repeat.fingerprint)
        .sort(),
    ).toEqual(['members.count', 'members.findById']);
  });

  // Hand-written SQL, a migration and the job queue's own statements carry no pair, so the text is
  // the only identity left — and a builder that indents differently between two calls still sent
  // one shape.
  test('unattributed SQL groups by its own text, with whitespace collapsed', () => {
    const ledger = createStatementLedger({ threshold: 3 });
    request(() => {
      ledger.observer.onStatement(statement('select 1\n  from "x_jobs"\n'));
      ledger.observer.onStatement(statement('select 1 from "x_jobs"'));
      ledger.observer.onStatement(statement('  select 1   from "x_jobs" '));
    });
    expect(ledger.repeats().map((repeat) => repeat.fingerprint)).toEqual([
      'select 1 from "x_jobs"',
    ]);
  });

  test('an attributed shape and an unattributed one never merge', () => {
    const ledger = createStatementLedger({ threshold: 2 });
    request(() => {
      for (let sent = 0; sent < 2; sent += 1) {
        ledger.observer.onStatement(statement(SELECT_ONE, { attribution: FIND_BY_ID }));
        ledger.observer.onStatement(statement(SELECT_ONE));
      }
    });
    expect(ledger.repeats()).toHaveLength(2);
  });
});

describe('unit · read or write decides which fix the verdict can name', () => {
  const kindOfLoop = (text: string, sent: Sent = {}): string | undefined => {
    const ledger = createStatementLedger({ threshold: 2 });
    request(() => {
      ledger.observer.onStatement(statement(text, sent));
      ledger.observer.onStatement(statement(text, sent));
    });
    return ledger.repeats()[0]?.kind;
  };

  test('a select loop is a read', () => {
    expect(kindOfLoop(SELECT_ONE)).toBe('read');
  });

  test('insert, update and delete loops are writes', () => {
    expect(kindOfLoop('insert into "posts" ("id") values ($1) returning *')).toBe('write');
    expect(kindOfLoop('update "posts" set "title" = $1 where "id" = $2')).toBe('write');
    expect(kindOfLoop('delete from "posts" where "id" = $1')).toBe('write');
  });

  // The statement decides, never the operation above it: a soft delete IS an update, and an op
  // list here would have to be kept in step with `@ultimat3/entity`'s method names forever.
  test("a soft delete is a write even though its operation is called 'delete'", () => {
    const soft = 'update "posts" set "deleted_at" = $1 where "id" = $2';
    expect(kindOfLoop(soft, { attribution: { entity: 'posts', op: 'delete' } })).toBe('write');
  });
});

describe('unit · a declared loop is measured and not judged', () => {
  // `expectedQueryLoop` suppresses a verdict, not a statement — and this ledger is the verdict.
  test('an expected loop never reaches the threshold', () => {
    const ledger = createStatementLedger();
    request(() => {
      for (let sent = 0; sent < 20; sent += 1) {
        ledger.observer.onStatement(
          statement(SELECT_ONE, { expected: 'one indexed lookup per search field' }),
        );
      }
    });
    expect(ledger.repeats()).toEqual([]);
  });

  test('an expected statement cannot push an unargued shape over the line', () => {
    const ledger = createStatementLedger();
    request(() => {
      for (let sent = 0; sent < DEFAULT_REPEAT_THRESHOLD - 1; sent += 1) {
        ledger.observer.onStatement(statement(SELECT_ONE));
      }
      for (let sent = 0; sent < 10; sent += 1) {
        ledger.observer.onStatement(
          statement(SELECT_ONE, { expected: 'migrations run one by one' }),
        );
      }
    });
    expect(ledger.repeats()).toEqual([]);
  });

  // Fifty identical timeouts are still fifty statements — a detector that reported them as none
  // would go quiet exactly when the loop started costing the most.
  test('a statement that threw is still a statement', () => {
    const ledger = createStatementLedger();
    request(() => {
      for (let sent = 0; sent < DEFAULT_REPEAT_THRESHOLD; sent += 1) {
        ledger.observer.onStatement(
          statement(SELECT_ONE, { error: new Error('connection lost'), rows: 0 }),
        );
      }
    });
    expect(ledger.repeats()[0]?.count).toBe(DEFAULT_REPEAT_THRESHOLD);
  });
});

describe('unit · the ledger is bounded and configurable', () => {
  test('the report list drops its oldest verdict, newest first', () => {
    const ledger = createStatementLedger({ threshold: 1, limit: 2 });
    request(() => {
      for (const table of ['a', 'b', 'c']) {
        ledger.observer.onStatement(statement(`select 1 from "${table}"`));
      }
    });
    expect(ledger.repeats().map((repeat) => repeat.fingerprint)).toEqual([
      'select 1 from "c"',
      'select 1 from "b"',
    ]);
  });

  test('reset clears the verdicts, so a restarted dev server starts quiet', () => {
    const ledger = createStatementLedger({ threshold: 1 });
    request(() => {
      ledger.observer.onStatement(statement(SELECT_ONE));
    });
    expect(ledger.repeats()).toHaveLength(1);
    ledger.reset();
    expect(ledger.repeats()).toEqual([]);
  });

  test('a threshold no statement count can reach is X_INVARIANT, not a silent no-op', () => {
    let caught: unknown;
    try {
      createStatementLedger({ threshold: 0 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeUltimateError('X_INVARIANT');
  });

  test('a limit that would keep no verdict is X_INVARIANT', () => {
    let caught: unknown;
    try {
      createStatementLedger({ limit: 0 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeUltimateError('X_INVARIANT');
  });
});

describe('unit · the verdicts of one request, for the page that request answered', () => {
  test("repeatsFor answers the loops of that context and nobody else's", () => {
    const ledger = createStatementLedger({ threshold: 2 });
    const looped = request((ctx) => {
      ledger.observer.onStatement(statement(SELECT_ONE, { attribution: FIND_BY_ID }));
      ledger.observer.onStatement(statement(SELECT_ONE, { attribution: FIND_BY_ID }));
      return ctx;
    });
    const quiet = request((ctx) => {
      ledger.observer.onStatement(statement(SELECT_ONE, { attribution: FIND_BY_ID }));
      return ctx;
    });

    expect(ledger.repeatsFor(looped).map((repeat) => repeat.fingerprint)).toEqual([
      'members.findById',
    ]);
    // One below the threshold is not a loop, and a request with no tally at all is not an error.
    expect(ledger.repeatsFor(quiet)).toEqual([]);
    expect(ledger.repeatsFor(createContext({}))).toEqual([]);
  });

  test('a verdict the bound already dropped is still on the request it happened in', () => {
    const ledger = createStatementLedger({ threshold: 1, limit: 1 });
    const ctx = request((current) => {
      ledger.observer.onStatement(statement('select 1 from "a"'));
      ledger.observer.onStatement(statement('select 1 from "b"'));
      return current;
    });

    // The global list keeps one; the request's own page must still name both loops it tripped.
    expect(ledger.repeats()).toHaveLength(1);
    expect(
      ledger
        .repeatsFor(ctx)
        .map((repeat) => repeat.fingerprint)
        .sort(),
    ).toEqual(['select 1 from "a"', 'select 1 from "b"']);
  });

  test('a shape still counting reports its live count, on both readers', () => {
    const ledger = createStatementLedger({ threshold: 2 });
    const ctx = request((current) => {
      for (let sent = 0; sent < 9; sent += 1) {
        ledger.observer.onStatement(statement(SELECT_ONE));
      }
      return current;
    });

    expect(ledger.repeats()[0]?.count).toBe(9);
    expect(ledger.repeatsFor(ctx)[0]?.count).toBe(9);
  });
});

describe('unit · one log line per request per code', () => {
  test('a second shape of the same kind does not warn twice in one request', () => {
    const ledger = createStatementLedger({ threshold: 1 });
    request(() => {
      ledger.observer.onStatement(statement('select 1 from "a"'));
      ledger.observer.onStatement(statement('select 1 from "b"'));
      ledger.observer.onStatement(statement('select 1 from "c"'));
    });

    expect(ledger.repeats()).toHaveLength(3);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('X_N_PLUS_ONE_QUERY: ');
  });

  test('a read loop and a write loop are two codes, so they are two lines', () => {
    const ledger = createStatementLedger({ threshold: 1 });
    request(() => {
      ledger.observer.onStatement(statement(SELECT_ONE));
      ledger.observer.onStatement(statement('insert into "posts" ("id") values ($1)'));
    });

    expect(warnings.map((line) => line.split(':')[0])).toEqual([
      'X_N_PLUS_ONE_QUERY',
      'X_N_PLUS_ONE_WRITE',
    ]);
  });

  test('the next request warns again — the rule is per request, not per process', () => {
    const ledger = createStatementLedger({ threshold: 1 });
    request(() => {
      ledger.observer.onStatement(statement(SELECT_ONE));
    });
    request(() => {
      ledger.observer.onStatement(statement(SELECT_ONE));
    });

    expect(warnings).toHaveLength(2);
  });

  test('the line carries the fix, and a shape counted past the threshold does not warn again', () => {
    const ledger = createStatementLedger({ threshold: 2 });
    request(() => {
      for (let sent = 0; sent < 20; sent += 1) {
        ledger.observer.onStatement(statement(SELECT_ONE, { attribution: FIND_BY_ID }));
      }
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('members.findById ran 2 times');
    expect(warnings[0]).toContain(" — fix: db.members.andWhere('id', 'in', ids).all()");
  });

  test('an expected loop is not counted, so it is not logged either', () => {
    const ledger = createStatementLedger({ threshold: 1 });
    request(() => {
      ledger.observer.onStatement(
        statement(SELECT_ONE, { expected: 'one indexed read per field' }),
      );
    });

    expect(ledger.repeats()).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
