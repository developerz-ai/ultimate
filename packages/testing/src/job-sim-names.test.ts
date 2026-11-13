// The effect log names a queue id by its ordinal. Replacing every known id in every key, one id at
// a time, was ids × effects: a job that enqueues 500 others ran its crash proof's 50 s there on an
// adopter. The namer reads the ids once per log and each key once, and answers what the
// one-id-at-a-time loop answers — including the keys where only that loop's answer is right.

import { describe, expect, test } from 'bun:test';
import { uuidV7 } from '@ultimat3/core';
import { ordinalNamer } from './job-sim-names';
import { testName } from './test-types';

/** The loop the namer replaces, kept as the oracle: every id, in insertion order, split and joined. */
const oneAtATime = (ordinals: ReadonlyMap<string, string>, key: string): string => {
  let out = key;
  for (const [id, ordinal] of ordinals) out = out.split(id).join(ordinal);
  return out;
};

/** A map that counts how often it is walked. */
class CountingMap<K, V> extends Map<K, V> {
  walks = 0;
  override [Symbol.iterator](): MapIterator<[K, V]> {
    this.walks += 1;
    return super[Symbol.iterator]();
  }
  override entries(): MapIterator<[K, V]> {
    this.walks += 1;
    return super.entries();
  }
  override keys(): MapIterator<K> {
    this.walks += 1;
    return super.keys();
  }
  override forEach(...args: Parameters<Map<K, V>['forEach']>): void {
    this.walks += 1;
    super.forEach(...args);
  }
}

describe(testName('unit', 'ordinalNamer · queue ids by ordinal'), () => {
  test('reads the ids once however many keys it names', () => {
    const ordinals = new CountingMap<string, string>();
    const ids = Array.from({ length: 500 }, () => uuidV7());
    for (const [i, id] of ids.entries()) ordinals.set(id, `job#${i + 1}`);
    const name = ordinalNamer(ordinals);
    const keys = ids.map((id) => `enqueue:sweep:${id}`);
    const named = keys.map(name);
    expect(named[0]).toBe('enqueue:sweep:job#1');
    expect(named[499]).toBe('enqueue:sweep:job#500');
    expect(ordinals.walks).toBeLessThanOrEqual(1);
  });

  test('answers what the one-id-at-a-time loop answers', () => {
    const [a, b, c] = [uuidV7(), uuidV7(), uuidV7()] as [string, string, string];
    const ordinals = new Map([
      [a, 'job#1'],
      [b, 'run#1'],
      [c, 'job#2'],
    ]);
    const name = ordinalNamer(ordinals);
    const keys = [
      `row:posts:delete:${a}`,
      `mail:${b}→${c},${a}`,
      `${a}${a}`,
      `x${b}0`,
      `hex-run:${a}abc`,
      `${c.slice(0, 20)}`,
      'no id at all',
      '',
      `enqueue:${uuidV7()}`,
    ];
    for (const key of keys) expect(name(key)).toBe(oneAtATime(ordinals, key));
  });

  test('ids of any other shape fall back to the loop, so they are still named', () => {
    const ordinals = new Map([
      ['job-7', 'job#1'],
      ['ABC', 'run#1'],
    ]);
    const name = ordinalNamer(ordinals);
    for (const key of ['enqueue:job-7', 'a:ABC:job-7', 'none'])
      expect(name(key)).toBe(oneAtATime(ordinals, key));
  });
});
