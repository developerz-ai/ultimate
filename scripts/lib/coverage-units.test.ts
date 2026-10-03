// What one coverage unit points `bun test` at. A bare `packages/<name>` is a SUBSTRING filter to
// `bun test`, so `packages/mcp` also ran the tracked apps' own `packages/mcp` suites into the
// framework package's measurement.

import { describe, expect, test } from 'bun:test';
import { atOf, SCRIPTS_UNIT, unitOf } from './coverage-units';

describe('unitOf', () => {
  test('a package unit is a path, never a substring filter', () => {
    const unit = unitOf('mcp');
    expect(unit.test).toBe('./packages/mcp');
    expect(unit.source).toBe('packages/mcp/src/');
    expect(atOf(unit)).toBe('packages/mcp');
  });

  test('every unit, scripts included, is spelled as a path', () => {
    for (const unit of [unitOf('core'), unitOf('create-ultimate'), SCRIPTS_UNIT]) {
      expect(unit.test.startsWith('./')).toBe(true);
    }
  });
});
