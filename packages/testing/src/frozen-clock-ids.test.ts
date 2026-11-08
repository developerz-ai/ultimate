// An id minted under the frozen clock is unique for the life of the process — across every run an
// exercise pass or a crash proof makes, each of which reseeds `Math.random` and resets the instant.
// `uuidV7` draws its random bits from `crypto`, which no seal seeds, and keeps one counter per
// process; a frozen instant repeated is the same millisecond again, so the counter moves on.

import { expect, test } from 'bun:test';
import { typedId, uuidV7 } from '@ultimat3/core';
import { newId } from '@ultimat3/entity';
import {
  captureDeterminism,
  DEFAULT_NOW,
  installDeterminism,
  restoreCapturedDeterminism,
  seededRandom,
  setFrozenClock,
} from './determinism';
import { testName } from './test-types';

/** One simulated run: what `openSimWorld` and the pass do before a body runs. */
const oneRun = (mint: () => string, count: number): readonly string[] => {
  setFrozenClock(DEFAULT_NOW);
  Math.random = seededRandom(1);
  return Array.from({ length: count }, mint);
};

test(testName('unit', 'ids under the frozen clock never repeat across reseeded runs'), () => {
  const before = captureDeterminism();
  installDeterminism();
  try {
    // Past 4,096 in one millisecond: the counter overflows into the next one, still unique.
    const minted = [newId, uuidV7, () => typedId<'job'>()].flatMap((mint) =>
      [1, 2, 3].flatMap(() => oneRun(mint, 5_000)),
    );
    expect(new Set(minted).size).toBe(minted.length);
  } finally {
    restoreCapturedDeterminism(before);
  }
});
