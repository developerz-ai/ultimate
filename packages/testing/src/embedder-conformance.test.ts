// The embedder suite over `@ultimat3/ai`'s hash embedder, and the proof it can fail: an embedder
// that answers its batch in reverse, and one that hands an empty text no direction at all.

import { describe, expect, test } from 'bun:test';
import { hashEmbedder } from '@ultimat3/ai';
import type { Embedder } from '@ultimat3/ai/adapter';
import { EMBEDDER_CHECKS, embedderConformance } from './embedder-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe(testName('unit', 'the hash embedder'), () => {
  behavesLike(embedderConformance, () => hashEmbedder());
});

const real = hashEmbedder({ dimension: 16 });

/** Every vector right, the batch answered backwards: the cache would key one prompt on another. */
const reversing: Embedder = {
  name: 'reversing',
  dimension: real.dimension,
  embed: async (texts) => [...(await real.embed(texts))].reverse(),
};

/** One zero vector per text: every cosine against it is NaN, and nothing ever ranks. */
const directionless: Embedder = {
  name: 'directionless',
  dimension: 4,
  embed: async (texts) => texts.map(() => new Float32Array(4)),
};

const check = (prefix: string) => {
  const found = EMBEDDER_CHECKS.find((each) => each.name.startsWith(prefix));
  if (found === undefined) return expect.unreachable(`no embedder check named ${prefix}`);
  return found;
};

describe(testName('unit', 'an embedder that breaks the contract fails conformance'), () => {
  test('a reversed batch fails the order check, and only the checks that read order', async () => {
    await expect(check('the batch keeps the order').run(reversing)).rejects.toThrow();
    await check('one vector per text').run(reversing);
  });

  test('a zero vector fails the direction check', async () => {
    await expect(check('a text has a direction').run(directionless)).rejects.toThrow();
  });

  test('every check has a name of its own', () => {
    const names = EMBEDDER_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
