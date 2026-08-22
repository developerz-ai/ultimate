// The two claims that made replacing this file's local serialiser with `@ultimat3/core`'s safe:
// `canonical` IS core's function rather than a copy of it, and the manifest body holds no value the
// two forms would disagree on. Core's is injective — `-0`, `NaN`, `±Infinity` and `Date` each get a
// token — and `JSON.stringify` folds all four, so a fact carrying one would move `buildId`.

import { describe, expect, test } from 'bun:test';
import { canonicalJson } from '@ultimat3/core';
import type { FrameworkManifest, FrameworkManifestBody } from './framework-manifest';
import { contentHash } from './framework-manifest';

/**
 * Every value in the tree that `JSON.stringify` cannot write down, by path. Deliberately a walk
 * rather than a round-trip comparison: `JSON.parse(JSON.stringify(x))` turns `-0` into `0`, and a
 * `toEqual` on that round-trip calls the two equal — so the one case that silently moves a hash is
 * the one case the cheaper check cannot see.
 */
function foldedByJson(value: unknown, path = '$'): readonly string[] {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return [`${path} is NaN`];
    if (!Number.isFinite(value)) return [`${path} is ${value > 0 ? 'Infinity' : '-Infinity'}`];
    return Object.is(value, -0) ? [`${path} is -0`] : [];
  }
  if (value instanceof Date) return [`${path} is a Date`];
  if (value instanceof Map || value instanceof Set) {
    return [`${path} is a ${value.constructor.name}`];
  }
  if (typeof value === 'bigint') return [`${path} is a bigint`];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => foldedByJson(item, `${path}[${index}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      foldedByJson(item, `${path}.${key}`),
    );
  }
  return [];
}

const committed = (await Bun.file(
  new URL('../../framework.manifest.json', import.meta.url).pathname,
).json()) as FrameworkManifest;

/** Spelled out rather than derived, so a new top-level fact is a type error here and not a miss. */
const body: FrameworkManifestBody = {
  version: committed.version,
  tiers: committed.tiers,
  packages: committed.packages,
  errorCodes: committed.errorCodes,
};

describe('unit · the framework manifest hashes through @ultimat3/core, not a copy', () => {
  /**
   * A SOURCE assertion, not an identity one. The file used to re-export core's function under the
   * old name, and comparing the two exports proved they were one function — but the name is gone
   * now, and a comparison against an export that no longer exists cannot fail. What must stay true
   * is that this file declares no serialiser of its own: the copy this replaced was
   * `JSON.stringify(sortKeys(value))`, and it is the FIFTH such copy the tree has carried.
   */
  test('the file declares no serialiser of its own — a reintroduced local pair fails here', async () => {
    const source = await Bun.file(
      new URL('./framework-manifest.ts', import.meta.url).pathname,
    ).text();
    expect(source).toContain("from '@ultimat3/core'");
    expect(source).toContain('canonicalJson');
    expect(source).not.toMatch(/function\s+sortKeys/);
    expect(source).not.toMatch(/function\s+canonical\b/);
    expect(source).not.toContain('JSON.stringify(sortKeys');
  });

  test("the committed buildId is core's hash of the committed body", () => {
    expect(contentHash(body)).toBe(committed.buildId);
  });

  test('and the hash moves when a fact does, so the assertion above is not vacuous', () => {
    const moved: FrameworkManifestBody = { ...body, tiers: { ...body.tiers, '9': ['ghost'] } };
    expect(contentHash(moved)).not.toBe(committed.buildId);
  });

  /**
   * The precondition for the swap, checked rather than assumed: a manifest fact carrying a `Date`
   * or a `NaN` would be written to disk by `JSON.stringify` as `"…"`/`null` and hashed by core as
   * `Date(…)`/`NaN`, so the committed `buildId` could never be recomputed from the file.
   */
  test('no manifest fact carries a value JSON.stringify folds', () => {
    expect(foldedByJson(body)).toEqual([]);
  });

  test('the walk that says so can fail — each folded value is reported by path', () => {
    expect(
      foldedByJson({ packages: [{ name: 'a', at: new Date(0) }], tiers: { '0': [Number.NaN] } }),
    ).toEqual(['$.packages[0].at is a Date', '$.tiers.0[0] is NaN']);
    expect(foldedByJson({ n: -0 })).toEqual(['$.n is -0']);
    expect(foldedByJson({ n: 1, s: 'x', b: true, nil: null })).toEqual([]);
  });

  /**
   * Why the swap moved no byte, stated as an assertion instead of as a claim in a comment: for a
   * body of plain JSON values the two forms are the same string. The day they are not, this reds
   * BEFORE `buildId` changes under a reader that recomputes it from the file.
   */
  test("core's canonical form of the body is byte-identical to sorted-key JSON", () => {
    const sortKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(sortKeys);
      if (typeof value !== 'object' || value === null) return value;
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, sortKeys(record[key])]),
      );
    };
    expect(canonicalJson(body)).toBe(JSON.stringify(sortKeys(body)));
  });
});
