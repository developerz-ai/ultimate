// Single responsibility: the request budget leaving this process on the next hop's headers. The
// inbound half lives in `deadline.test.ts`; this file asks the question nothing asked before —
// what a handler's own outbound call tells the service it is calling.
//
// The failure it pins: `x-request-timeout-ms` had exactly ONE reader (`resolveTimeoutMs`) and zero
// writers anywhere in the tree, while `wiki/Agents.md` said the client sent it. Gateway -> A (30s
// budget) -> B: at t=29 A called B, and B started a FRESH 30s — a query, a provider call, a write,
// running for 30 seconds after the caller's socket had already been answered `X_TIMEOUT`, holding
// a pool slot the whole time. Under load that is retry amplification, not a slow request.

import { describe, expect, test } from 'bun:test';
import { REQUEST_TIMEOUT_HEADER, traceHeaders, useContext } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { createPipeline } from './pipeline';
import { json } from './response';
import { createRouter, type Route } from './router';

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/hop',
    meta: { name: 'hop', auth: 'public' },
    // Exactly what `@ultimat3/action`'s `postOnce` puts on an outbound request, from inside a
    // handler — the ambient context is the only thing either one reads.
    handler: () => json({ outbound: traceHeaders(), deadlineAt: useContext().deadlineAt }),
  },
];

const pipelineWith = (requestTimeoutMs: number): ReturnType<typeof createPipeline> =>
  createPipeline({
    table: createRouter(routes),
    config: defineHttpConfig({
      dev: false,
      buildId: null,
      requestTimeoutMs,
      rateLimit: { scope: 'process' },
    }),
  });

const hop = async (
  requestTimeoutMs: number,
  headers?: HeadersInit,
): Promise<{ outbound: Record<string, string>; deadlineAt: number | null }> => {
  const response = await pipelineWith(requestTimeoutMs).handle(
    new Request('http://localhost/hop', headers === undefined ? undefined : { headers }),
    { role: 'web' },
  );
  return (await response.json()) as { outbound: Record<string, string>; deadlineAt: number | null };
};

describe('the request budget crosses the hop', () => {
  test('a handler sends what is LEFT of its own budget, never a fresh one', async () => {
    const answered = await hop(5_000);
    const sent = Number(answered.outbound[REQUEST_TIMEOUT_HEADER]);
    expect(Number.isFinite(sent)).toBe(true);
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThanOrEqual(5_000);
    expect(answered.deadlineAt).toBeGreaterThan(0);
  });

  test("a caller's shorter budget is the one that propagates, not this process's config", async () => {
    const answered = await hop(30_000, { [REQUEST_TIMEOUT_HEADER]: '900' });
    expect(Number(answered.outbound[REQUEST_TIMEOUT_HEADER])).toBeLessThanOrEqual(900);
  });

  test('requestTimeoutMs: 0 is no deadline, so nothing is asked of the next hop', async () => {
    const answered = await hop(0);
    expect(answered.deadlineAt).toBeNull();
    expect(answered.outbound[REQUEST_TIMEOUT_HEADER]).toBeUndefined();
  });
});
