// Single responsibility: tests for the attribution scope itself — installed vs. uninstalled
// (axiom 6: nothing allocated when no observer is watching), across awaits and a microtask,
// under nesting, under two scopes running at once, and on a throw. Whether the two funnels
// actually stamp `StatementEvent.attribution` from this scope is client.test.ts/pglite.test.ts's.

import { afterEach, describe, expect, test } from 'bun:test';
import { statementAttribution, withStatementAttribution } from './attribution';
import type { StatementAttribution } from './observe';
import { setStatementObserver } from './observe';

/** Any installed observer opens the gate — which one is not what this file is testing. */
function installObserver(): void {
  setStatementObserver({ onStatement: () => undefined });
}

/** Two scopes interleave deterministically only if each can hand the turn over on demand. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = (): void => settle();
  });
  return { promise, resolve };
}

afterEach(() => {
  setStatementObserver(undefined);
});

describe('withStatementAttribution', () => {
  // Axiom 6: with nothing installed the scope is never entered — not entered-and-then-invisible.
  // A regression to "always run storage.run" would still pass a check taken from outside the
  // call; reading from *inside* is the one assertion that tells the two apart.
  test('uninstalled: reads undefined outside and inside — the scope is never entered', () => {
    expect(statementAttribution()).toBeUndefined();

    const seen = withStatementAttribution('members', 'findById', () => statementAttribution());

    expect(seen).toBeUndefined();
  });

  test('installed: the pair is readable inside, and gone again once the call returns', () => {
    installObserver();

    const seen = withStatementAttribution('members', 'findById', () => statementAttribution());

    expect(seen).toEqual({ entity: 'members', op: 'findById' });
    expect(statementAttribution()).toBeUndefined();
  });

  test('returns whatever fn returns, sync and through a promise alike', async () => {
    installObserver();

    expect(withStatementAttribution('members', 'findById', () => 42)).toBe(42);
    const awaited = await withStatementAttribution('members', 'findById', async () => {
      await Promise.resolve();
      return 'ok';
    });
    expect(awaited).toBe('ok');
  });

  test('survives an await at depth', async () => {
    installObserver();
    const nested = async (): Promise<StatementAttribution | undefined> => {
      await Promise.resolve();
      await Promise.resolve();
      return statementAttribution();
    };

    const seen = await withStatementAttribution('members', 'findById', async () => {
      await Promise.resolve();
      return nested();
    });

    expect(seen).toEqual({ entity: 'members', op: 'findById' });
  });

  // The entity coalescer flushes a batched `findById` from a microtask (`coalesce.ts`'s
  // `queueMicrotask` in `openBatch`), so the one lookup that sends for fifty callers has to see
  // the pair from inside a `queueMicrotask`, not only across a plain `await`.
  test('a queueMicrotask scheduled inside the scope reads the pair', async () => {
    installObserver();

    const seen = await new Promise<StatementAttribution | undefined>((resolve) => {
      withStatementAttribution('members', 'findById', () => {
        queueMicrotask(() => resolve(statementAttribution()));
      });
    });

    expect(seen).toEqual({ entity: 'members', op: 'findById' });
  });

  test('nesting keeps the innermost pair, and the outer one comes back after', () => {
    installObserver();

    withStatementAttribution('members', 'findMany', () => {
      expect(statementAttribution()).toEqual({ entity: 'members', op: 'findMany' });
      withStatementAttribution('posts', 'findById', () => {
        expect(statementAttribution()).toEqual({ entity: 'posts', op: 'findById' });
      });
      expect(statementAttribution()).toEqual({ entity: 'members', op: 'findMany' });
    });
  });

  test('two concurrent scopes interleaved by awaits never read each other', async () => {
    installObserver();
    const started = deferred();
    const read = deferred();

    // `first` suspends inside its own scope while `second` runs entirely inside its own.
    const first = withStatementAttribution('members', 'findById', async () => {
      started.resolve();
      await read.promise;
      return statementAttribution();
    });
    const second = withStatementAttribution('posts', 'findById', async () => {
      await started.promise;
      const mine = statementAttribution();
      read.resolve();
      return mine;
    });

    expect(await Promise.all([first, second])).toEqual([
      { entity: 'members', op: 'findById' },
      { entity: 'posts', op: 'findById' },
    ]);
    expect(statementAttribution()).toBeUndefined();
  });

  test('a throw leaves no scope behind, on either the sync or the async path', async () => {
    installObserver();

    expect(() =>
      withStatementAttribution('members', 'findById', () => {
        throw new Error('repository call failed');
      }),
    ).toThrow('repository call failed');
    expect(statementAttribution()).toBeUndefined();

    await expect(
      withStatementAttribution('members', 'findById', async () => {
        throw new Error('awaited repository call failed');
      }),
    ).rejects.toThrow('awaited repository call failed');
    expect(statementAttribution()).toBeUndefined();
  });
});
