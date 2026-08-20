// The attribution half: which package a `tsc` diagnostic counts against, and the two ways this
// parser could report a false zero — a line it cannot read, and a package it reads as the wrong
// one. Both matter more than the count itself: a ratchet keyed on the wrong package excuses errors
// in one package with a pin written for another.

import { describe, expect, test } from 'bun:test';
import { countByPackage, packageOf, parseDiagnostics } from './test-typecheck';

const OUTPUT = [
  "packages/entity/src/repo.test.ts(12,5): error TS4111: Property 'id' comes from an index signature.",
  "packages/entity/src/repo.test.ts(19,9): error TS2345: Argument of type 'string' is not assignable.",
  'packages/core/e2e/version.e2e.test.ts(4,1): error TS2304: Cannot find name.',
  '    Type undefined is not assignable — a continuation line, not a diagnostic.',
].join('\n');

describe('reading tsc output', () => {
  test('one diagnostic per error line, and continuation lines are not errors', () => {
    const diagnostics = parseDiagnostics(OUTPUT);
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics[0]).toEqual({
      file: 'packages/entity/src/repo.test.ts',
      line: 12,
      code: 4111,
      text: "Property 'id' comes from an index signature.",
    });
  });

  test('nothing at all reads as nothing, never as a crash', () => {
    expect(parseDiagnostics('')).toEqual([]);
  });

  test('the count is per package, and an e2e file counts for its package too', () => {
    expect(countByPackage(parseDiagnostics(OUTPUT))).toEqual({ entity: 2, core: 1 });
  });
});

describe('which package a file belongs to', () => {
  test('the directory decides, not the file name', () => {
    expect(packageOf('packages/render/src/island.test.ts')).toBe('render');
    expect(packageOf('packages/cli/e2e/registry-boot.e2e.test.ts')).toBe('cli');
  });

  test('an absolute path answers the same as a relative one', () => {
    expect(packageOf('/home/x/ultimate/packages/mcp/src/tool.test.ts')).toBe('mcp');
  });

  test('a windows separator is not a package called "packages\\ui"', () => {
    expect(
      packageOf(parseDiagnostics('packages\\ui\\src\\a.test.ts(1,1): error TS1: x')[0]?.file ?? ''),
    ).toBe('ui');
  });

  test('a file outside packages/ belongs to no package, and is counted for none', () => {
    expect(packageOf('scripts/verify.ts')).toBeUndefined();
    expect(countByPackage(parseDiagnostics('scripts/verify.ts(1,1): error TS2304: x'))).toEqual({});
  });
});
