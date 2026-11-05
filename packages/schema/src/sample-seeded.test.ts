// The seeded draw is only worth running if three things hold: it replays, it stays legal, and it
// reaches the corners a minimal sample never visits. Each test below is one of those claims.

import { describe, expect, test } from 'bun:test';
import type { AnySchema } from './builder';
import { arbitrary, BOUNDARY_RUNS, minimalDraw, seededDraw } from './sample';
import { SAMPLE_FIXTURES } from './sample-fixture';
import { t } from './t';

const SEEDS = [0, 1, 0x811c9dc5, 2_654_435_761, 4_294_967_295];
const RUNS = 64;

const accepts = (schema: AnySchema, value: unknown): boolean =>
  schema.safeParse(value).issues === undefined;

const at = (schema: AnySchema, run: number, seed = 7): unknown => arbitrary(schema, { seed, run });

describe('arbitrary', () => {
  test('the same seed and run answer the same value; another seed answers another', () => {
    const schema = SAMPLE_FIXTURES.find(([label]) => label === 'object')?.[1] ?? t.string;
    for (let run = 0; run < 16; run += 1) {
      expect(JSON.stringify(at(schema, run))).toBe(JSON.stringify(at(schema, run)));
    }
    const one = Array.from({ length: 16 }, (_, run) => JSON.stringify(at(schema, run, 1)));
    const two = Array.from({ length: 16 }, (_, run) => JSON.stringify(at(schema, run, 2)));
    expect(one).not.toEqual(two);
  });

  test('every drawn value is accepted by the schema it was drawn from', () => {
    const refused: string[] = [];
    for (const [label, schema] of SAMPLE_FIXTURES) {
      for (const seed of SEEDS) {
        for (let run = 0; run < RUNS; run += 1) {
          if (!accepts(schema, arbitrary(schema, { seed, run }))) refused.push(`${label}#${run}`);
        }
      }
    }
    // Named, not counted: a failure says which fixture and which run.
    expect(refused).toEqual([]);
  });

  test('runs 0-3 sit on the bounds the IR declares', () => {
    const between = t.string.min(2).max(5);
    expect([...(at(between, 0) as string)].length).toBe(2);
    expect([...(at(between, 1) as string)].length).toBe(5);
    const count = t.number.int().min(1).max(100);
    expect(at(count, 0)).toBe(1);
    expect(at(count, 1)).toBe(100);
    const page = t.array(t.uuid, { min: 2, max: 5 });
    expect((at(page, 0) as unknown[]).length).toBe(2);
    expect((at(page, 1) as unknown[]).length).toBe(5);
    expect(BOUNDARY_RUNS).toBe(4);
  });

  test('optional keys go on and off, and a nullable field is null on its boundary run', () => {
    const schema = t.object({ id: t.uuid, note: t.string.optional(), cover: t.nullable(t.url) });
    expect(Object.keys(at(schema, 0) as object)).toEqual(['id', 'cover']);
    expect(Object.keys(at(schema, 1) as object)).toEqual(['id', 'note', 'cover']);
    expect((at(schema, 2) as Record<string, unknown>)['cover']).toBeNull();
    expect((at(schema, 0) as Record<string, unknown>)['cover']).toBe('https://example.test/sample');
  });

  test('every enum value and every union member is drawn somewhere in sixteen runs', () => {
    const status = t.enumerated('draft', 'published', 'archived');
    expect(new Set(Array.from({ length: 16 }, (_, run) => at(status, run)))).toEqual(
      new Set(['draft', 'published', 'archived']),
    );
    const either = t.union(t.uuid, t.boolean);
    const kinds = new Set(Array.from({ length: 16 }, (_, run) => typeof at(either, run)));
    expect(kinds).toEqual(new Set(['string', 'boolean']));
  });

  test('a drawn string carries multibyte text, and a format value is never drawn', () => {
    const texts = Array.from({ length: 16 }, (_, run) => at(t.string.max(40), run) as string);
    expect(texts.some((text) => [...text].some((char) => char.length > 1 || char > '\u007f'))).toBe(
      true,
    );
    for (let run = 0; run < 16; run += 1) {
      expect(at(t.uuid, run)).toBe('00000000-0000-4000-8000-000000000000');
    }
  });

  test('a pattern a draw cannot meet falls back to the one value the walk can build', () => {
    const lower = t.string.pattern(/^[a-z]+$/);
    for (let run = 0; run < 16; run += 1) expect(accepts(lower, at(lower, run))).toBe(true);
  });
});

describe('seededDraw', () => {
  test('a seeded draw is a Draw: it answers every member the minimal one does', () => {
    expect(Object.keys(seededDraw(1, 9)).sort()).toEqual(Object.keys(minimalDraw).sort());
  });

  test('an empty choice list answers undefined rather than throwing', () => {
    expect(seededDraw(1, 9).member([])).toBeUndefined();
    expect(seededDraw(1, 0).member([])).toBeUndefined();
  });

  test('a number whose bounds cross falls back to the minimal answer', () => {
    const crossed = { kind: 'number', integer: true, minimum: 0.2, maximum: 0.8 } as const;
    expect(seededDraw(1, 9).number(crossed)).toBe(minimalDraw.number(crossed));
  });
});
