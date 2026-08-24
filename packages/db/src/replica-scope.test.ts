// Single responsibility: the scope's own behaviour — nothing in flight outside one, one store when
// nested, and a write that survives every `await` below it.

import { describe, expect, test } from 'bun:test';
import { markScopeWrote, replicaScope, withReplicaReads } from './replica-scope';

describe('withReplicaReads', () => {
  test('outside a scope nothing is in flight, and marking is a no-op rather than a throw', () => {
    expect(replicaScope()).toBeUndefined();
    markScopeWrote();
    expect(replicaScope()).toBeUndefined();
  });

  test('a fresh scope has not written', () => {
    withReplicaReads(() => {
      expect(replicaScope()).toEqual({ wrote: false });
    });
  });

  test('the scope closes when `fn` returns — a later read is not still inside it', () => {
    withReplicaReads(() => undefined);
    expect(replicaScope()).toBeUndefined();
  });

  test('a mark survives every await at any depth', async () => {
    await withReplicaReads(async () => {
      await Promise.resolve();
      await (async () => {
        await Promise.resolve();
        markScopeWrote();
      })();
      await Promise.resolve();
      expect(replicaScope()?.wrote).toBe(true);
    });
  });

  test('a nested scope is the SAME scope — an inner one may not un-write an outer one', () => {
    withReplicaReads(() => {
      markScopeWrote();
      const outer = replicaScope();
      withReplicaReads(() => {
        expect(replicaScope()).toBe(outer);
        expect(replicaScope()?.wrote).toBe(true);
      });
      expect(replicaScope()?.wrote).toBe(true);
    });
  });

  test('two concurrent scopes never read each other', async () => {
    const seen: boolean[] = [];
    const run = async (write: boolean): Promise<void> => {
      await withReplicaReads(async () => {
        await Promise.resolve();
        if (write) markScopeWrote();
        await Promise.resolve();
        seen.push(replicaScope()?.wrote ?? false);
      });
    };
    await Promise.all([run(true), run(false), run(true)]);
    expect(seen.filter(Boolean)).toHaveLength(2);
  });
});
