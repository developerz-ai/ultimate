// `conflict: 'last-write-wins'` is refused at declaration unless every entity row the mutator
// answers carries a NUMBER clock the server writes — otherwise it silently resolves to server-wins.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { clearRegistry, entity, integer, text, timestamp, uuid } from '@ultimat3/entity';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { mutator } from './mutator';

const Clocked = entity('mutator_clock_clocked', {
  columns: { id: uuid().primaryKey(), title: text({ max: 40 }), updatedAt: integer() },
});
const Unclocked = entity('mutator_clock_unclocked', {
  columns: { id: uuid().primaryKey(), title: text({ max: 40 }) },
});
const Stamped = entity('mutator_clock_stamped', {
  columns: { id: uuid().primaryKey(), updatedAt: timestamp() },
});

afterAll(() => {
  clearRegistry();
});

function declare(output: unknown, conflict: 'last-write-wins' | 'server-wins'): unknown {
  try {
    mutator({
      input: t.object({ id: t.uuid }),
      output: output as never,
      policy: can('post:edit'),
      local: () => {},
      server: () => ({}) as never,
      conflict,
    });
  } catch (error) {
    return error;
  }
  return undefined;
}

const codeOf = (thrown: unknown): string | undefined =>
  isUltimateError(thrown) ? thrown.code : undefined;

describe("conflict: 'last-write-wins' needs a clock", () => {
  test('an entity with a number updatedAt declares cleanly, bare or nested', () => {
    expect(declare(Clocked.$schema, 'last-write-wins')).toBeUndefined();
    expect(declare(t.object({ post: Clocked.$schema }), 'last-write-wins')).toBeUndefined();
  });

  test('an entity with no updatedAt is refused, naming the entity and the one-line repair', () => {
    const thrown = declare(Unclocked.$schema, 'last-write-wins');
    expect(codeOf(thrown)).toBe('X_MUTATOR_CLOCK_MISSING');
    expect(isUltimateError(thrown) && thrown.fix).toBe(
      "add updatedAt (a number, epoch ms, written by the server) to mutator_clock_unclocked, or declare conflict: 'server-wins'",
    );
  });

  test('a timestamp updatedAt is refused too: it reaches the client as a string, never a number', () => {
    expect(codeOf(declare(Stamped.$schema, 'last-write-wins'))).toBe('X_MUTATOR_CLOCK_MISSING');
  });

  test('one unclocked entity among clocked ones is enough to refuse', () => {
    const both = t.object({ a: Clocked.$schema, b: Unclocked.$schema });
    expect(codeOf(declare(both, 'last-write-wins'))).toBe('X_MUTATOR_CLOCK_MISSING');
  });

  test('an output with no entity row at all has nothing to compare, so it is refused', () => {
    expect(codeOf(declare(t.object({ ok: t.boolean }), 'last-write-wins'))).toBe(
      'X_MUTATOR_CLOCK_MISSING',
    );
  });

  test('server-wins needs no clock and is never refused', () => {
    expect(declare(Unclocked.$schema, 'server-wins')).toBeUndefined();
  });
});
