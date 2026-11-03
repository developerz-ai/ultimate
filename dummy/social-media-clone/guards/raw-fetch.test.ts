// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { rawFetches } from './raw-fetch';

const file = (source: string) => [{ path: 'apps/web/app/post/repo.ts', source }];

unitTest('a bare fetch is refused, and the finding names the line', () => {
  const findings = rawFetches(file('const a = 1;\nconst r = await fetch(url);'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_RAW_FETCH');
  expect(findings[0]?.at).toBe('apps/web/app/post/repo.ts:2');
});

unitTest('globalThis.fetch and a signal nested in another key are the same rule', () => {
  expect(rawFetches(file('await globalThis.fetch(url, { method: "POST" });'))).toHaveLength(1);
  expect(rawFetches(file('await fetch(url, { env: { signal } });'))).toHaveLength(1);
  expect(rawFetches(file('await fetch(url, init);'))).toHaveLength(1);
});

unitTest('a signal in its own options is what the rule asks for', () => {
  expect(rawFetches(file('await fetch(url, { signal });'))).toEqual([]);
  expect(rawFetches(file('await fetch(url, { method: "GET", signal: ctx.signal });'))).toEqual([]);
});

unitTest('an injected fetch, a handler definition and a comment are not calls', () => {
  expect(rawFetches(file('await deps.fetch(url);'))).toEqual([]);
  expect(rawFetches(file('Bun.serve({ fetch(request) { return new Response(); } });'))).toEqual([]);
  expect(rawFetches(file('// await fetch(url);'))).toEqual([]);
  expect(rawFetches(file("const s = 'fetch(url)';"))).toEqual([]);
});
