// The drill load against a real loopback server: lanes record status, code and timing, POSTs carry
// their own idempotency key, and the samples fold into the evidence the verdict reads.

import { afterEach, describe, expect, test } from 'bun:test';
import type { DrillSample } from './drill-load';
import { problemCode, recoveryAfter, requestEvidence, startDrillLoad } from './drill-load';
import { allowHost, resetNetwork } from './sealed-network';

const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  resetNetwork();
});

const sample = (over: Partial<DrillSample>): DrillSample => ({
  target: 'GET /',
  startedMs: 0,
  endedMs: 10,
  status: 200,
  code: undefined,
  ...over,
});

describe('problemCode', () => {
  test('reads an X_* code from a problem document, and nothing else', () => {
    const json = 'application/problem+json; charset=utf-8';
    expect(problemCode(json, '{"code":"X_DB_UNAVAILABLE"}')).toBe('X_DB_UNAVAILABLE');
    expect(problemCode(json, '{"code":"ECONNRESET"}')).toBeUndefined();
    expect(problemCode(json, 'not json')).toBeUndefined();
    expect(problemCode('text/html', '{"code":"X_DB_UNAVAILABLE"}')).toBeUndefined();
    expect(problemCode(null, '')).toBeUndefined();
  });
});

describe('requestEvidence', () => {
  test('ok, coded, uncoded (X_INTERNAL included), unanswered and the slowest', () => {
    const evidence = requestEvidence([
      sample({}),
      sample({ status: 503, code: 'X_DB_UNAVAILABLE', endedMs: 80 }),
      sample({ status: 500, code: 'X_INTERNAL' }),
      sample({ status: 502 }),
      sample({ status: null, endedMs: 5_000 }),
    ]);
    expect(evidence).toEqual({
      ok: 1,
      failedByCode: new Map([['X_DB_UNAVAILABLE', 1]]),
      uncoded: 2,
      unanswered: 1,
      maxMs: 80,
    });
  });
});

describe('recoveryAfter', () => {
  test('the first 2xx that started after the fault cleared', () => {
    const samples = [
      sample({ startedMs: 90, endedMs: 400 }),
      sample({ startedMs: 120, endedMs: 300, status: 503 }),
      sample({ startedMs: 150, endedMs: 260 }),
    ];
    expect(recoveryAfter(samples, 100)).toBe(160);
    expect(recoveryAfter(samples, 200)).toBeNull();
  });
});

describe('startDrillLoad', () => {
  test('lanes hit every target; a POST carries a fresh idempotency key', async () => {
    const keys: string[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const key = request.headers.get('idempotency-key');
        if (key !== null) keys.push(key);
        if (new URL(request.url).pathname === '/down') {
          return Response.json(
            { code: 'X_DB_UNAVAILABLE' },
            {
              status: 503,
              headers: { 'content-type': 'application/problem+json' },
            },
          );
        }
        return new Response('ok');
      },
    });
    servers.push(server);
    allowHost(`127.0.0.1:${String(server.port)}`);
    let turns = 0;
    let stop: () => void = () => undefined;
    const enough = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const load = startDrillLoad({
      base: `http://127.0.0.1:${String(server.port)}`,
      targets: [
        { method: 'GET', path: '/' },
        { method: 'POST', path: '/write', body: { a: 1 } },
        { method: 'GET', path: '/down' },
      ],
      lanes: 1,
      requestBoundMs: 5_000,
      // No wall clock: a lane yields one turn between requests and the test counts them.
      sleep: async () => {
        turns += 1;
        if (turns >= 6) stop();
      },
    });
    await enough;
    const samples = await load.stop();
    expect(samples.length).toBeGreaterThanOrEqual(6);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    const evidence = requestEvidence(samples);
    expect(evidence.failedByCode.get('X_DB_UNAVAILABLE')).toBeGreaterThanOrEqual(2);
    expect(evidence.uncoded).toBe(0);
  });

  test('a drawn POST sends the body for its own request number, so no two writes repeat', async () => {
    const bodies: unknown[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        bodies.push(await request.json());
        return new Response('ok');
      },
    });
    servers.push(server);
    allowHost(`127.0.0.1:${String(server.port)}`);
    let turns = 0;
    let stop: () => void = () => undefined;
    const enough = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const load = startDrillLoad({
      base: `http://127.0.0.1:${String(server.port)}`,
      targets: [
        { method: 'POST', path: '/write', body: { ignored: true }, draw: (run) => ({ run }) },
      ],
      lanes: 1,
      requestBoundMs: 5_000,
      sleep: async () => {
        turns += 1;
        if (turns >= 3) stop();
      },
    });
    await enough;
    await load.stop();
    expect(bodies.slice(0, 3)).toEqual([{ run: 1 }, { run: 2 }, { run: 3 }]);
  });

  test('a refused connection is unanswered, never a status', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const port = server.port;
    server.stop(true);
    allowHost(`127.0.0.1:${String(port)}`);
    let stop: () => void = () => undefined;
    const enough = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const load = startDrillLoad({
      base: `http://127.0.0.1:${String(port)}`,
      targets: [{ method: 'GET', path: '/' }],
      lanes: 1,
      requestBoundMs: 2_000,
      sleep: async () => stop(),
    });
    await enough;
    const evidence = requestEvidence(await load.stop());
    expect(evidence.unanswered).toBeGreaterThanOrEqual(1);
    expect(evidence.ok).toBe(0);
  });

  test('lanes must be a whole number of at least one', () => {
    expect(() =>
      startDrillLoad({ base: 'http://127.0.0.1:1', targets: [], lanes: 0, requestBoundMs: 1 }),
    ).toThrow(/lanes/);
  });
});
