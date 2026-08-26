// The funnel is the ONE place the observer hangs off, so "exactly one event per settled statement"
// is its contract and not the observer's. Colocated because `client-observer.test.ts` asserts what
// an observer SEES; this asserts what the funnel EMITS, including on the path that then throws.

import { afterEach, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { type StatementEvent, setStatementObserver } from './observe';
import { raw } from './sql';
import { affectedBy, rowsOf, runOn } from './statement-funnel';

const collect = (): StatementEvent[] => {
  const seen: StatementEvent[] = [];
  setStatementObserver({ onStatement: (event) => void seen.push(event) });
  return seen;
};

// Process-wide state: a suite that installs one and never removes it hands it to every later FILE
// in the run, and the failure lands somewhere innocent.
afterEach(() => setStatementObserver(undefined));

describe('runOn emits exactly one event per settled statement', () => {
  test('a statement that succeeds emits one event carrying its row count', async () => {
    const seen = collect();
    const rows = [{ id: 1 }, { id: 2 }];
    const result = await runOn({ unsafe: async () => rows }, raw('select 1'));

    expect(result).toBe(rows);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.text).toBe('select 1');
    expect(seen[0]?.rows).toBe(2);
    expect(seen[0]?.error).toBeUndefined();
  });

  test('a statement the driver rejects emits one event, and still throws', async () => {
    const seen = collect();
    const boom = new Error('connection reset');

    await expect(
      runOn(
        {
          unsafe: () => Promise.reject(boom),
        },
        raw('select 2'),
      ),
    ).rejects.toThrow(UltimateError);

    // A failed statement is still a statement — fifty identical timeouts are an N+1 of timeouts.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.rows).toBe(0);
    expect(seen[0]?.error).toBeDefined();
  });

  test('the driver failure is typed on the way out, never the bare driver error', async () => {
    try {
      await runOn({ unsafe: () => Promise.reject(new Error('nope')) }, raw('select 3'));
      expect.unreachable('a rejected driver call must throw');
    } catch (error) {
      if (!(error instanceof UltimateError)) throw error;
      expect(error.code).toBe('X_DB_UNAVAILABLE');
    }
  });

  test('an observer that throws on success does not report the statement as failed', async () => {
    // The success event is emitted OUTSIDE the try deliberately: a throw from `onStatement` is the
    // OBSERVER's, not the database's, and catching it would emit a SECOND event reporting a
    // statement that succeeded as failed. Asserting only that the throw escapes cannot see that —
    // it escapes either way — so the discriminating assertion is the event LEDGER, not the throw.
    const seen: StatementEvent[] = [];
    // Constructed as DATA, not raised at the throw site: this error is the subject's INPUT — a
    // deliberately broken observer — not this test's verdict, and `bun run scripts/test-bare-error.ts`
    // reads a literal throw of a freshly constructed Error as a verdict wherever it appears,
    // callback included — and its string-literal exemption does not cover comments either.
    const observerFailure = new Error('observer is broken');
    setStatementObserver({
      onStatement: (event) => {
        seen.push(event);
        throw observerFailure;
      },
    });

    await expect(runOn({ unsafe: async () => [] }, raw('select 4'))).rejects.toThrow(
      'observer is broken',
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.error).toBeUndefined();
  });

  test('no observer installed means no event and the same call the driver always got', async () => {
    let sawText: string | undefined;
    const result = await runOn(
      {
        unsafe: async (text: string) => {
          sawText = text;
          return [{ id: 9 }];
        },
      },
      raw('select 5'),
    );
    expect(sawText).toBe('select 5');
    expect(rowsOf<{ id: number }>(result)[0]?.id).toBe(9);
  });
});

// `affectedBy` is the funnel's half of a rule `pglite.ts` mirrors: `execute()` and the observer's
// event may not answer differently for the same statement depending on the driver behind them.
describe('affectedBy answers the command tag only when it counted something', () => {
  test('a positive count wins over the array length', () => {
    const tagged = Object.assign([], { count: 3 });
    expect(affectedBy(tagged)).toBe(3);
  });

  test('a read tagged zero while returning rows reports the rows, not the tag', () => {
    const tagged = Object.assign([{ id: 1 }, { id: 2 }], { count: 0 });
    expect(affectedBy(tagged)).toBe(2);
  });

  test('a non-array result affects nothing', () => {
    expect(affectedBy(undefined)).toBe(0);
    expect(rowsOf(undefined)).toEqual([]);
  });
});
