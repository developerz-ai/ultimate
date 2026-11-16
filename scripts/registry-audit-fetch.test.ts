// The registry audit's real fetch seam, against a loopback server: the caller's verb and deadline
// reach the request by name — a dropped `signal` is a registry that never answers holding the audit.

import { describe, expect, test } from 'bun:test';
import { allowHost } from '../packages/testing/src/sealed-network';
import { defaultFetch } from './registry-audit';

describe('the real fetch seam', () => {
  // The seam forwards the caller's deadline and verb by name: a dropped `signal` is a registry
  // that accepts and never answers holding the audit forever.
  test('forwards the method and the signal the caller set', async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => {
        seen.push(request.method);
        return new Response('{}');
      },
    });
    try {
      allowHost(`127.0.0.1:${String(server.port)}`);
      const url = `http://127.0.0.1:${String(server.port)}/`;
      await defaultFetch(url, { signal: AbortSignal.timeout(5_000), method: 'HEAD' });
      await defaultFetch(url, { signal: AbortSignal.timeout(5_000) });
      expect(seen).toEqual(['HEAD', 'GET']);
      const aborted = defaultFetch(url, { signal: AbortSignal.abort() });
      await expect(aborted).rejects.toThrow();
    } finally {
      await server.stop(true);
    }
  });
});
