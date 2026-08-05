import { afterEach, describe, expect, test } from 'bun:test';
import { isSelfOrigin, listeningOrigins, markListening, resetListeners } from './listeners';

afterEach(() => {
  resetListeners();
});

describe('listeners', () => {
  test('an announced socket is self, an unannounced one is not', () => {
    expect(isSelfOrigin('http://127.0.0.1:4310/healthz')).toBe(false);
    markListening('http://127.0.0.1:4310');
    expect(isSelfOrigin('http://127.0.0.1:4310/healthz')).toBe(true);
    expect(listeningOrigins()).toEqual(['http://127.0.0.1:4310']);
  });

  test('every loopback spelling of the same port is the same socket', () => {
    markListening('http://0.0.0.0:4311');
    for (const url of [
      'http://localhost:4311/x',
      'http://127.0.0.1:4311/x',
      'http://[::1]:4311/x',
      'http://LOCALHOST:4311/x',
    ]) {
      expect(isSelfOrigin(url)).toBe(true);
    }
  });

  test('a different port or a real host is never self', () => {
    markListening('http://127.0.0.1:4312');
    expect(isSelfOrigin('http://127.0.0.1:4313/x')).toBe(false);
    expect(isSelfOrigin('https://api.stripe.com/v1/charges')).toBe(false);
    expect(isSelfOrigin('not a url')).toBe(false);
  });

  test('the default port is implied, so origin and bare URL agree', () => {
    markListening('https://app.example.com');
    expect(isSelfOrigin('https://app.example.com:443/x')).toBe(true);
    expect(isSelfOrigin('https://app.example.com/x')).toBe(true);
    expect(isSelfOrigin('http://app.example.com/x')).toBe(false);
  });

  test('release is refcounted and idempotent, so one stop cannot unseal the other server', () => {
    const first = markListening('http://127.0.0.1:4314');
    const second = markListening('http://localhost:4314');
    first();
    first();
    expect(isSelfOrigin('http://127.0.0.1:4314/x')).toBe(true);
    second();
    expect(isSelfOrigin('http://127.0.0.1:4314/x')).toBe(false);
    expect(listeningOrigins()).toEqual([]);
  });

  test('a non-URL origin fails loudly instead of silently never matching', () => {
    expect(() => markListening('127.0.0.1:4315')).toThrow(/X_INVARIANT/);
  });
});
