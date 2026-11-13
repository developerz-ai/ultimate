// The generators `property()` draws from: each draw is a value AND its shrinks, so a mapped or
// nested generator shrinks through its source instead of guessing at its output. Seeded only —
// the caller hands the random source in — and every shrink halves the distance to the smallest
// value, so a counterexample of a million arrives in twenty steps. The runner is `property.ts`.

import { finiteCount } from '@ultimat3/core';

/** One drawn value and, lazily, the smaller values a failure is retried with — closest first. */
export interface Shrinkable<T> {
  readonly value: T;
  readonly shrinks: () => Iterable<Shrinkable<T>>;
}

/** `size` grows from 0 to 1 over a run, so the first draws are the small edge cases. */
export interface Gen<T> {
  readonly draw: (random: () => number, size: number) => Shrinkable<T>;
}

const mapTree = <A, B>(tree: Shrinkable<A>, f: (value: A) => B): Shrinkable<B> => ({
  value: f(tree.value),
  *shrinks() {
    for (const smaller of tree.shrinks()) yield mapTree(smaller, f);
  },
});

/**
 * `target` first, then the distance halved again and again — `v - d/2`, `v - d/4`, … `v - 1` —
 * so a failure that holds at a boundary is found by bisection, never by counting down to it.
 */
const intTree = (value: number, target: number): Shrinkable<number> => ({
  value,
  *shrinks() {
    if (value === target) return;
    yield intTree(target, target);
    for (let gap = Math.trunc((value - target) / 2); gap !== 0; gap = Math.trunc(gap / 2)) {
      yield intTree(value - gap, target);
    }
  },
});

/** Every position shrunk in turn, the others held: a tuple's failure is one field's. */
const tupleTree = <T>(items: readonly Shrinkable<T>[]): Shrinkable<readonly T[]> => ({
  value: items.map((item) => item.value),
  *shrinks() {
    for (let at = 0; at < items.length; at += 1) {
      for (const smaller of items[at]?.shrinks() ?? []) {
        yield tupleTree(items.map((item, index) => (index === at ? smaller : item)));
      }
    }
  },
});

/** Halves first (drop the back, drop the front), then one item out, then each item smaller. */
const listTree = <T>(items: readonly Shrinkable<T>[], min: number): Shrinkable<readonly T[]> => ({
  value: items.map((item) => item.value),
  *shrinks() {
    const half = Math.floor(items.length / 2);
    if (half >= min && half < items.length) {
      yield listTree(items.slice(0, half), min);
      yield listTree(items.slice(items.length - half), min);
    }
    if (items.length - 1 >= min) {
      for (let at = 0; at < items.length; at += 1) {
        yield listTree([...items.slice(0, at), ...items.slice(at + 1)], min);
      }
    }
    yield* tupleTree(items).shrinks();
  },
});

const pick = (random: () => number, low: number, high: number): number =>
  low + Math.floor(random() * (high - low + 1));

/** A whole number in `[min, max]`, shrinking toward the one nearest zero. Bounds drawn 1 in 8. */
const int = (min: number, max: number): Gen<number> => ({
  draw(random) {
    const target = Math.min(Math.max(0, min), max);
    const roll = random();
    const value = roll < 1 / 16 ? min : roll < 1 / 8 ? max : pick(random, min, max);
    return intTree(value, target);
  },
});

/** One of `values`, shrinking toward the first: list the simplest value first. */
const oneOf = <T>(values: readonly [T, ...T[]]): Gen<T> =>
  map(int(0, values.length - 1), (at) => values[at] ?? values[0]);

/** One of `gens`, shrinking inside the one drawn: a union never jumps branch while shrinking. */
const union = <T>(gens: readonly [Gen<T>, ...Gen<T>[]]): Gen<T> => ({
  draw: (random, size) => (gens[pick(random, 0, gens.length - 1)] ?? gens[0]).draw(random, size),
});

const map = <A, B>(gen: Gen<A>, f: (value: A) => B): Gen<B> => ({
  draw: (random, size) => mapTree(gen.draw(random, size), f),
});

const constant = <T>(value: T): Gen<T> => ({ draw: () => ({ value, shrinks: () => [] }) });

/** At most `maxLength` items, fewer while `size` is small. Default 16. */
export interface LengthOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
}

const lengthOf = (random: () => number, size: number, options: LengthOptions): [number, number] => {
  const min = finiteCount('gen', 'minLength', options.minLength ?? 0);
  const max = Math.max(finiteCount('gen', 'maxLength', options.maxLength ?? 16), min);
  return [pick(random, min, min + Math.ceil((max - min) * size)), min];
};

const array = <T>(item: Gen<T>, options: LengthOptions = {}): Gen<readonly T[]> => ({
  draw(random, size) {
    const [length, min] = lengthOf(random, size, options);
    return listTree(
      Array.from({ length }, () => item.draw(random, size)),
      min,
    );
  },
});

const tuple = <T extends readonly unknown[]>(
  ...gens: { readonly [K in keyof T]: Gen<T[K]> }
): Gen<T> => ({
  draw: (random, size) =>
    tupleTree(gens.map((gen: Gen<unknown>) => gen.draw(random, size))) as Shrinkable<T>,
});

/** Code points a codec mishandles: separators, quotes, `%`, a combining mark, CJK, an astral emoji. */
export const HOSTILE_CHARS: readonly [string, ...string[]] = [
  'a',
  'Z',
  '0',
  ' ',
  '-',
  '_',
  '.',
  ',',
  ';',
  '=',
  '%',
  '"',
  "'",
  '\\',
  '/',
  '{',
  '}',
  '\n',
  '\t',
  '\u0000',
  'é',
  '́',
  'ß',
  'ж',
  'ع',
  '漢',
  ' ',
  ' ',
  '🙂',
  '👍🏽',
];

const string = (options: LengthOptions & { readonly chars?: Gen<string> } = {}): Gen<string> =>
  map(array(options.chars ?? oneOf(HOSTILE_CHARS), options), (chars) => chars.join(''));

const bytes = (options: LengthOptions = {}): Gen<Uint8Array> =>
  map(array(int(0, 255), options), (list) => Uint8Array.from(list));

/** Plain JSON: `null`, booleans, safe integers, finite fractions, strings, arrays, objects. */
const json = (depth = 3): Gen<unknown> => {
  const leaves: [Gen<unknown>, ...Gen<unknown>[]] = [
    constant(null),
    oneOf([false, true]),
    int(-(2 ** 53) + 1, 2 ** 53 - 1),
    map(int(-1_000_000, 1_000_000), (n) => n / 64),
    string({ maxLength: 8 }),
  ];
  if (depth <= 0) return union(leaves);
  const inner = json(depth - 1);
  return union([
    ...leaves,
    array(inner, { maxLength: 4 }),
    map(array(tuple(string({ maxLength: 6 }), inner), { maxLength: 4 }), (entries) =>
      Object.fromEntries(entries),
    ),
  ]);
};

/** The generators. Compose them; a generator is a value, never a class to extend. */
export const gen = { int, oneOf, union, map, constant, array, tuple, string, bytes, json } as const;
