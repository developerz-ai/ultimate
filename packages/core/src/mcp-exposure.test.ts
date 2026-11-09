import { describe, expect, test } from 'bun:test';
import { isAgentOffered, isMcpExposed } from './mcp-exposure';

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

describe('isAgentOffered', () => {
  test('an exposed primitive is offered to an in-app agent too', () => {
    expect(isAgentOffered({ expose: true })).toBe(true);
  });

  test('agents: true offers it to in-app agents without publishing it', () => {
    const declared = { expose: false, agents: true };
    expect(isAgentOffered(declared)).toBe(true);
    expect(isMcpExposed(declared)).toBe(false);
  });

  test('silence, false and a truthy non-boolean offer nothing', () => {
    expect(isAgentOffered(undefined)).toBe(false);
    expect(isAgentOffered({ expose: false })).toBe(false);
    expect(isAgentOffered({ expose: false, agents: false })).toBe(false);
    const parsed = JSON.parse('{"agents":1}') as { agents?: boolean };
    expect(isAgentOffered(parsed)).toBe(false);
  });
});
