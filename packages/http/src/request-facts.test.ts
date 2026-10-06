// The one facts shape a token resolver reads, on every bearer surface: the address is the host's
// answer and never a header read here, and the object is frozen so a resolver cannot rewrite it
// for the next reader.

import { describe, expect, test } from 'bun:test';
import { requestFacts } from './request-facts';

const headers = (init: Record<string, string>): Headers => new Headers(init);

describe('requestFacts', () => {
  test('reads the four facts, the path without its query, frozen', () => {
    const facts = requestFacts({
      headers: headers({ 'user-agent': 'claude-code/2.1', origin: 'https://app.example.com' }),
      url: 'http://local/a/mcp?x=1',
      address: '198.51.100.4',
    });
    expect(facts).toEqual({
      address: '198.51.100.4',
      userAgent: 'claude-code/2.1',
      origin: 'https://app.example.com',
      path: '/a/mcp',
    });
    expect(Object.isFrozen(facts)).toBe(true);
  });

  test('x-forwarded-for is never read: no host address is no address', () => {
    const facts = requestFacts({
      headers: headers({ 'x-forwarded-for': '6.6.6.6' }),
      url: new URL('http://local/v1/x'),
      address: undefined,
    });
    expect(facts).toEqual({ address: null, userAgent: null, origin: null, path: '/v1/x' });
  });

  test("an opaque origin stays the string 'null', distinct from an absent header", () => {
    const facts = requestFacts({
      headers: headers({ origin: 'null' }),
      url: 'http://l/',
      address: null,
    });
    expect(facts.origin).toBe('null');
  });
});
