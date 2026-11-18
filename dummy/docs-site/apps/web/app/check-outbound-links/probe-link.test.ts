import { expect, test } from 'bun:test';
import { probeLink } from './probe-link';

const answering = (status: number) => async () => new Response(null, { status });

test.each([
  [404, 'dead'],
  [410, 'dead'],
  [200, 'alive'],
  // Refused or throttled is the host's answer about this client, never about the page.
  [403, 'alive'],
  [429, 'alive'],
  [500, 'alive'],
] as const)('a %i answer reads as %s', async (status, verdict) => {
  expect(await probeLink('https://bun.sh/', answering(status))).toEqual({ verdict, status });
});

test('a host that cannot be reached is its own verdict, not a thrown step', async () => {
  const refused = async () => {
    throw new TypeError('connection refused');
  };
  expect(await probeLink('https://bun.sh/', refused)).toEqual({
    verdict: 'unreachable',
    status: null,
  });
});

test('the probe asks for headers only, under a deadline, following redirects', async () => {
  const seen: RequestInit[] = [];
  await probeLink('https://bun.sh/', async (_url, init) => {
    seen.push(init);
    return new Response(null, { status: 200 });
  });
  expect(seen[0]?.method).toBe('HEAD');
  expect(seen[0]?.redirect).toBe('follow');
  expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
});
