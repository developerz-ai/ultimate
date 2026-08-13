import { describe, expect, test } from 'bun:test';
import { isMcpExposed } from './mcp-exposure';

describe('isMcpExposed', () => {
  test('a literal true is the only opt-in', () => {
    expect(isMcpExposed({ expose: true })).toBe(true);
  });

  test('an absent block exposes nothing', () => {
    expect(isMcpExposed(undefined)).toBe(false);
  });

  test('a declared block with no expose exposes nothing', () => {
    expect(isMcpExposed({})).toBe(false);
  });

  test('an explicit false exposes nothing', () => {
    expect(isMcpExposed({ expose: false })).toBe(false);
  });

  test('a truthy non-boolean is not an opt-in', () => {
    // JSON reaches this from a manifest file, where nothing checked the type first: `1` or
    // `'true'` must read as "the author did not say true", never as consent.
    const parsed = JSON.parse('{"expose":1}') as { expose?: boolean };
    expect(isMcpExposed(parsed)).toBe(false);
    const asString = JSON.parse('{"expose":"true"}') as { expose?: boolean };
    expect(isMcpExposed(asString)).toBe(false);
  });

  test('reads a richer declaration structurally', () => {
    const actionMcp = { expose: true, description: 'Publish a draft post', visibleTo: ['admin'] };
    expect(isMcpExposed(actionMcp)).toBe(true);
  });
});
