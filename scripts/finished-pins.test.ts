// `finished-pins.ts`: the no-exemption-debt row over fixture tables and their source — a bare
// count, a `// why:` above it, a `{ count, reason }` row, a reason section, an array of keys.

import { describe, expect, test } from 'bun:test';
import { pinsRow } from './finished-pins';

const table = (value: unknown, source: string) => ({
  path: 'scripts/lib/a-pins.ts',
  table: 'A_PINS',
  value,
  source,
});

describe('finished · no-exemption-debt', () => {
  test('an empty table is green', () => {
    expect(pinsRow([table({}, 'export const A_PINS = {};')]).verdict).toBe('green');
  });

  test('a bare count is red, at its key line', () => {
    const source = 'export const A_PINS = {\n  // a ratchet\n  cli: 3,\n};\n';
    const row = pinsRow([table({ cli: 3 }, source)]);
    expect(row.verdict).toBe('red');
    expect(row.findings[0]?.code).toBe('X_FINISHED_PIN_UNREASONED');
    expect(row.findings[0]?.at).toBe('scripts/lib/a-pins.ts:3');
  });

  test('a why: comment above or beside the key reasons it', () => {
    const above =
      'export const A_PINS = {\n  // why: the seam the rule cannot see\n  cli: 3,\n};\n';
    const beside = "export const A_PINS = {\n  'cli': 3, // why: one hop away\n};\n";
    expect(pinsRow([table({ cli: 3 }, above)]).verdict).toBe('green');
    expect(pinsRow([table({ cli: 3 }, beside)]).verdict).toBe('green');
  });

  test('a reason field, a string value and a section of reasons are reasoned', () => {
    const value = {
      a: { count: 1, reason: 'why: kept' },
      b: { sites: 2, why: 'appends a cookie' },
      c: 'moved from the readme',
      exceptions: { e: 'a verb' },
      owed: {},
    };
    expect(pinsRow([table(value, '')]).verdict).toBe('green');
  });

  test('a string in an array is a key, not a reason', () => {
    const source = "export const A_UNPINNED = [\n  'a row nobody pinned',\n];\n";
    expect(pinsRow([table(['a row nobody pinned'], source)]).verdict).toBe('red');
  });
});
