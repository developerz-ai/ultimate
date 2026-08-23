// The enforcement half of `scripts/proto-index.ts`: this file IS the build error. The gate's
// `unit` step runs every `scripts/**/*.test.ts`, so a `TABLE[name]` on a plain object literal
// re-entering the tree fails `bun run verify` with no extra wiring.
//
// The first block is the four worst of the thirteen shipped instances, reduced to their shape.

import { describe, expect, test } from 'bun:test';
import { PROTO_INDEX_PINS } from './lib/proto-index-pins';
import { repoRoot } from './lib/run';
import {
  checkProtoIndex,
  protoIndexFindingFor,
  protoIndexGaps,
  recordTables,
  scanProtoIndex,
} from './proto-index';

const keys = (source: string): readonly string[] =>
  scanProtoIndex('packages/x/src/a.ts', source).map((site) => `${site.table}[${site.key}]`);

describe('the shape that shipped thirteen times', () => {
  /** `core/context.ts:203` — `useService('constructor')` answered the `Object` function. */
  test('an annotated Record read with a parameter is reported', () => {
    const source = [
      'const SERVICES: Readonly<Record<string, Service>> = {};',
      'export const useService = (name: string) => SERVICES[name] ?? missing(name);',
    ].join('\n');
    expect(keys(source)).toEqual(['SERVICES[name]']);
  });

  /** `ai/vector-scope.ts:59` — the frozen form, which `frozen-records.ts` requires. */
  test('the Object.freeze<Record<…>> form is a Record too', () => {
    const source = [
      'const SCOPES = Object.freeze<Record<string, Scope>>({});',
      'const scope = SCOPES[input.tenant];',
    ].join('\n');
    expect(keys(source)).toEqual(['SCOPES[input.tenant]']);
  });

  test('the finding names Object.hasOwn and the table', () => {
    const gaps = checkProtoIndex({
      files: [
        {
          path: 'packages/core/src/context.ts',
          source:
            'const SERVICES: Record<string, S> = {};\nexport const use = (n: string) => SERVICES[n];',
        },
      ],
      pins: {},
    });
    const finding = protoIndexFindingFor(gaps[0] as never);
    expect(finding.code).toBe('X_PROTO_CHAIN_INDEX');
    expect(finding.at).toBe('packages/core/src/context.ts:2');
    expect(finding.fix).toContain('Object.hasOwn(SERVICES, n)');
    expect(finding.fix).toContain('Object.create(null)');
  });
});

describe('the repairs the rule RECOGNISES rather than pins', () => {
  const table = 'const T: Record<string, number> = {};\n';

  test('a null-prototype table has no prototype to reach — packages/i18n/src/catalog.ts', () => {
    expect(
      keys('const T: Record<string, number> = Object.create(null);\nconst v = T[key];'),
    ).toEqual([]);
    expect(keys(`${table}const U = { __proto__: null };\nconst v = T[key];`)).toEqual([]);
  });

  test('a string literal key cannot be "constructor" unless somebody typed it', () => {
    expect(keys(`${table}const v = T['web'];`)).toEqual([]);
    expect(keys(`${table}const v = T["web"];`)).toEqual([]);
  });

  test('an Object.hasOwn guard on the same line settles it', () => {
    expect(keys(`${table}const v = Object.hasOwn(T, key) ? T[key] : undefined;`)).toEqual([]);
  });

  test('an `in` guard settles it too', () => {
    expect(keys(`${table}if (key in T) {\n  return T[key];\n}`)).toEqual([]);
  });

  test('a WRITE builds the table, and the prototype answer never reaches a caller', () => {
    expect(keys(`${table}T[key] = 1;`)).toEqual([]);
    expect(keys(`${table}T[key] += 1;`)).toEqual([]);
    expect(keys(`${table}T[key] ??= 1;`)).toEqual([]);
  });

  test('but `===` is a read, not a write — one `=` apart', () => {
    expect(keys(`${table}if (T[key] === 1) return;`)).toEqual([`T[key]`]);
  });

  test('an index inside a string literal is a scaffold template, not this file own read', () => {
    expect(keys(`${table}const s = \`const v = T[kind];\`;`)).toEqual([]);
  });

  test('a name that is not a Record object literal is not this rule subject', () => {
    expect(keys('const rows: string[] = [];\nconst v = rows[index];')).toEqual([]);
    expect(keys('const m = new Map<string, number>();\nconst v = m.get(key);')).toEqual([]);
  });
});

describe('recordTables', () => {
  test('collects both declaration forms and drops everything on a null-prototyped file', () => {
    expect([...recordTables('const A: Readonly<Record<K, V>> = {};')]).toEqual(['A']);
    expect([...recordTables('const B = Object.freeze<Record<K, V>>({});')]).toEqual(['B']);
    expect([...recordTables('const C: Partial<Record<K, V>> = {};')]).toEqual(['C']);
    expect([...recordTables('const D: Record<K, V> = Object.create(null);')]).toEqual([]);
  });
});

describe('the ratchet', () => {
  test('a pin above what the tree holds is stale, with the command that lowers it', () => {
    const gaps = checkProtoIndex({
      files: [{ path: 'packages/x/src/a.ts', source: 'const a = 1;' }],
      pins: { x: { count: 2, reason: 'a fixture' } },
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(['stale']);
    expect(protoIndexFindingFor(gaps[0] as never).code).toBe('X_PROTO_CHAIN_INDEX_PIN_STALE');
  });

  test('an empty corpus is UNSCANNED, never a clean tree', () => {
    expect(protoIndexFindingFor(checkProtoIndex({ files: [], pins: {} })[0] as never).code).toBe(
      'X_PROTO_CHAIN_INDEX_UNSCANNED',
    );
  });

  test('every pin carries a sentence saying what the key is — a blank one is a waiver', () => {
    for (const [pkg, pin] of Object.entries(PROTO_INDEX_PINS)) {
      expect(`${pkg}: ${pin.reason}`.length).toBeGreaterThan(pkg.length + 50);
      expect(pin.count).toBeGreaterThan(0);
    }
  });

  test('the tree is on the ratchet', async () => {
    expect(await protoIndexGaps(repoRoot())).toEqual([]);
  });
});
