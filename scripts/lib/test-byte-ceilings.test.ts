// A byte ceiling pinned inside a test file (`client-bundle.test.ts`'s `RPC_MINIFIED_BYTES_MAX`, a
// `toBeLessThan(16_186)` in a bundle test) is a ratchet like any `*-pins.ts` row: a raise names its
// reason in the same diff, or `pin-raises` reports `X_PIN_RAISE_UNSTATED`.

import { describe, expect, test } from 'bun:test';
import { checkPinRaises } from '../pin-raises';
import { testBytePins, testBytePinTable } from './test-byte-ceilings';

const PATH = 'packages/demo/src/client-bundle.test.ts';

const CONST_PIN = (bytes: string, why: string) =>
  [
    '/**',
    ` * measured: 25,281 B (2026-11-19). ${why}`,
    ' */',
    `const RPC_BYTES_MAX = ${bytes};`,
    "test('rpc', async () => {",
    '  expect(code.length).toBeLessThanOrEqual(RPC_BYTES_MAX);',
    '});',
  ].join('\n');

const LITERAL_PIN = (bytes: string, comment: string) =>
  [
    `  // ${comment}`,
    "  test('stays under 16 kB minified', async () => {",
    '    const { bytes } = await build(true);',
    `    expect(bytes).toBeLessThan(${bytes});`,
    '    expect(reads).toBeLessThanOrEqual(8);',
    '  }, 60_000);',
  ].join('\n');

describe('unit · test-file byte pins', () => {
  test('a named ceiling and a literal one are rows; a small count is not a byte pin', () => {
    expect(testBytePins(CONST_PIN('25_303', 'why: a'))).toEqual([
      { key: 'RPC_BYTES_MAX', value: 25_303, line: 4 },
    ]);
    expect(testBytePins(LITERAL_PIN('16_186', 'why: b'))).toEqual([
      { key: 'stays under 16 kB minified', value: 16_186, line: 2 },
    ]);
  });

  test('a raise with no new why: is X_PIN_RAISE_UNSTATED; one with its own why: is not', () => {
    const base = CONST_PIN('25_000', 'why: the transport');
    const silent = testBytePinTable(PATH, CONST_PIN('25_303', 'why: the transport'), base);
    expect(checkPinRaises([silent]).map((raise) => [raise.row, raise.was, raise.now])).toEqual([
      ['bytes.RPC_BYTES_MAX', 25_000, 25_303],
    ]);
    const stated = testBytePinTable(PATH, CONST_PIN('25_303', 'why: +303 B, the stream'), base);
    expect(checkPinRaises([stated])).toEqual([]);
  });

  test("a literal pin's why: may sit above its test or inside it", () => {
    const base = LITERAL_PIN('16_174', 'measured 16,170. why: the trim');
    const silent = testBytePinTable(
      PATH,
      LITERAL_PIN('16_186', 'measured 16,170. why: the trim'),
      base,
    );
    expect(checkPinRaises([silent])).toHaveLength(1);
    const stated = testBytePinTable(
      PATH,
      LITERAL_PIN('16_186', 'why: +12 B, the write rule'),
      base,
    );
    expect(checkPinRaises([stated])).toEqual([]);
  });

  test('a lowered pin, or one unchanged, asks nothing', () => {
    const base = CONST_PIN('25_303', 'why: a');
    expect(checkPinRaises([testBytePinTable(PATH, CONST_PIN('25_000', 'why: a'), base)])).toEqual(
      [],
    );
    expect(checkPinRaises([testBytePinTable(PATH, base, base)])).toEqual([]);
  });

  test('a file new since the base is a raise from 0 per row, never licensed by an import why:', () => {
    const fresh = [
      '// why: Bun ships no path API.',
      "import { join } from 'node:path';",
      LITERAL_PIN('8_000', 'measured 7,900 B'),
    ].join('\n');
    expect(checkPinRaises([testBytePinTable(PATH, fresh, undefined)])).toHaveLength(1);
  });
});
