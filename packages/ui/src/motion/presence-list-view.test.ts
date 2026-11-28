// PresenceList's rule, with no renderer: one root per key (as `data-table-rows.ts`), a removed key
// HELD in place while it exits and disposed only after, a returning key reversed mid-exit.

import { describe, expect, test } from 'bun:test';
import { UiError } from '../errors';
import { INERT_SOLID_RUNTIME } from '../theme/inert-runtime';
import type { MotionHandle } from './animate';
import { mergeOrder, presenceRows } from './presence-list-view';

describe('mergeOrder', () => {
  test('a leaving key keeps its place after the key it followed', () => {
    expect(mergeOrder(['a', 'b', 'c'], ['a', 'c'], new Set(['b']))).toEqual(['a', 'b', 'c']);
  });

  test('a leaving first key stays first; the new order rules the rest', () => {
    expect(mergeOrder(['a', 'b', 'c'], ['c', 'b'], new Set(['a']))).toEqual(['a', 'c', 'b']);
  });

  test('a run of leaving keys stays together, in order', () => {
    expect(mergeOrder(['a', 'b', 'c', 'd'], ['a', 'd'], new Set(['b', 'c']))).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });
});

interface Item {
  readonly id: string;
}

function harness(options: { appear?: boolean } = {}) {
  const log: string[] = [];
  const finishers = new Map<string, () => void>();
  let rendered: string[] = [];
  const rows = presenceRows<Item, string>(
    INERT_SOLID_RUNTIME,
    (item) => item.id,
    (item, key, ref) => {
      ref({ id: key } as unknown as Element);
      log.push(`build ${key}`);
      return `node:${item().id}`;
    },
    (el, kind): MotionHandle => {
      const key = (el as unknown as Item).id;
      log.push(`${kind} ${key}`);
      const finished = new Promise<void>((resolve) => finishers.set(key, resolve));
      return {
        finished,
        cancel: () => log.push(`cancel ${key}`),
        reverse: () => log.push(`reverse ${key}`),
      };
    },
    (nodes) => {
      rendered = [...nodes];
    },
    options,
  );
  const settle = async (key: string): Promise<void> => {
    finishers.get(key)?.();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { rows, log, settle, rendered: () => rendered };
}

const items = (...ids: string[]): Item[] => ids.map((id) => ({ id }));

describe('presenceRows', () => {
  test('the first render builds every row and animates none of them', () => {
    const h = harness();
    h.rows.update(items('a', 'b'));
    expect(h.rendered()).toEqual(['node:a', 'node:b']);
    expect(h.log).toEqual(['build a', 'build b']);
  });

  test('appear: the first render enters every row', () => {
    const h = harness({ appear: true });
    h.rows.update(items('a'));
    expect(h.log).toEqual(['build a', 'enter a']);
  });

  test('an added key is built once and enters after it is rendered', () => {
    const h = harness();
    h.rows.update(items('a'));
    h.rows.update(items('a', 'b'));
    expect(h.rendered()).toEqual(['node:a', 'node:b']);
    expect(h.log).toEqual(['build a', 'build b', 'enter b']);
  });

  test('a removed key stays rendered, in place, until its exit finishes', async () => {
    const h = harness();
    h.rows.update(items('a', 'b', 'c'));
    h.rows.update(items('a', 'c'));
    expect(h.rendered()).toEqual(['node:a', 'node:b', 'node:c']);
    await h.settle('b');
    expect(h.rendered()).toEqual(['node:a', 'node:c']);
  });

  test('a key back mid-exit reverses the exit and is never rebuilt', async () => {
    const h = harness();
    h.rows.update(items('a', 'b'));
    h.rows.update(items('a'));
    h.rows.update(items('a', 'b'));
    await h.settle('b');
    expect(h.rendered()).toEqual(['node:a', 'node:b']);
    expect(h.log).toEqual(['build a', 'build b', 'exit b', 'reverse b', 'cancel b']);
  });

  test('a key gone after its exit is built afresh when it returns', async () => {
    const h = harness();
    h.rows.update(items('a'));
    h.rows.update(items());
    await h.settle('a');
    h.rows.update(items('a'));
    expect(h.log).toEqual(['build a', 'exit a', 'build a', 'enter a']);
  });

  test('two rows under one key is X_UI_INVALID_VALUE', () => {
    const h = harness();
    expect(() => h.rows.update(items('a', 'a'))).toThrow(UiError);
  });

  test('dispose cancels every running exit', () => {
    const h = harness();
    h.rows.update(items('a', 'b'));
    h.rows.update(items());
    h.rows.dispose();
    expect(h.log.filter((line) => line.startsWith('cancel'))).toEqual(['cancel a', 'cancel b']);
  });
});

describe('presenceRows — turning back and forth', () => {
  test('removed again mid-reversal: the same animation turns again, no second exit', () => {
    const h = harness();
    h.rows.update(items('a', 'b'));
    h.rows.update(items('a'));
    h.rows.update(items('a', 'b'));
    h.rows.update(items('a'));
    expect(h.log).toEqual(['build a', 'build b', 'exit b', 'reverse b', 'reverse b']);
  });

  test('an exit turned back is cancelled once at rest, so its held frame lets go', async () => {
    const h = harness();
    h.rows.update(items('a', 'b'));
    h.rows.update(items('a'));
    h.rows.update(items('a', 'b'));
    await h.settle('b');
    expect(h.log).toEqual(['build a', 'build b', 'exit b', 'reverse b', 'cancel b']);
    expect(h.rendered()).toEqual(['node:a', 'node:b']);
  });
});
