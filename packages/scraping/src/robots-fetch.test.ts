import { describe, expect, test } from 'bun:test';
import { createRobotsGate } from './robots';
import { DEFAULT_ROBOTS_MAX_BYTES, robotsFetcher } from './robots-fetch';

const streamOf = (chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const bodyResponse = (body: ReadableStream<Uint8Array>, status = 200): Response =>
  new Response(body, { status });

/** Resolves only when the caller's signal aborts — a hung CDN, without the wait. */
const hangingFetch: typeof fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    const signal = (init as RequestInit | undefined)?.signal;
    if (signal == null) return;
    signal.addEventListener('abort', () => {
      reject(signal.reason ?? new Error('aborted'));
    });
  });

describe('unit · the default robots.txt read', () => {
  test('a hung origin gives up on the deadline instead of parking the run forever', async () => {
    const read = robotsFetcher({ timeoutMs: 25, fetch: hangingFetch });
    const started = performance.now();
    // Unreadable ALLOWS, which is this gate's documented answer — the point is that it answers.
    expect(await read('https://slow.test/robots.txt')).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("the run's own cancellation unwinds the read", async () => {
    const controller = new AbortController();
    const read = robotsFetcher({ signal: controller.signal, fetch: hangingFetch });
    const pending = read('https://slow.test/robots.txt');
    controller.abort();
    expect(await pending).toBeUndefined();
  });

  test('a robots.txt past the cap is abandoned, never held in full', async () => {
    let pulled = 0;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const read = robotsFetcher({
      maxBytes: 4 * 1024,
      fetch: () => Promise.resolve(bodyResponse(oversized)),
    });
    expect(await read('https://huge.test/robots.txt')).toBeUndefined();
    // The cap is enforced by counting as the stream arrives, so the producer is stopped early
    // rather than after a multi-gigabyte body has already been materialised by `.text()`.
    expect(pulled).toBeLessThan(4);
  });

  test('a body inside the cap is decoded and returned', async () => {
    const text = 'User-agent: *\nDisallow: /private';
    const read = robotsFetcher({
      fetch: () => Promise.resolve(bodyResponse(streamOf([new TextEncoder().encode(text)]))),
    });
    expect(await read('https://ok.test/robots.txt')).toBe(text);
  });

  test('a non-2xx answer reads as "no restrictions"', async () => {
    const read = robotsFetcher({
      fetch: () => Promise.resolve(bodyResponse(streamOf([]), 404)),
    });
    expect(await read('https://gone.test/robots.txt')).toBeUndefined();
  });

  // The exit is RESOLVED per read, never captured at construction: the gate is built as an
  // argument to `driver.open()`, and the proxy is a driver option resolved inside it — so a
  // string captured here could only ever be the one nobody has yet, which is how the robots read
  // came to exit from the worker's IP while every page load exited through the proxy.
  test('the exit is resolved per read, and only dialled when there is one', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const record: typeof fetch = (_url, init) => {
      seen.push((init ?? {}) as Record<string, unknown>);
      return Promise.resolve(bodyResponse(streamOf([])));
    };
    let exit: string | undefined;
    const read = robotsFetcher({ proxy: () => exit, fetch: record });
    await read('https://a.test/robots.txt');
    // `driver.open()` has now returned, and the session dialled through a proxy.
    exit = 'http://exit:8080';
    await read('https://b.test/robots.txt');
    expect('proxy' in (seen[0] ?? {})).toBe(false);
    expect(seen[1]?.['proxy']).toBe('http://exit:8080');
  });

  test('the cap is a real number of bytes, not a placeholder', () => {
    expect(DEFAULT_ROBOTS_MAX_BYTES).toBeGreaterThan(0);
  });
});

describe('unit · the gate takes the deadline without a fetchText injected', () => {
  // The gap that hid this: every existing gate test injects `fetchText`, so the path production
  // actually takes (`scrape-run.ts` constructs the gate with no `fetchText`) had no coverage.
  test('a hung origin does not park every later navigation on one cached promise', async () => {
    const gate = createRobotsGate({
      policy: 'obey',
      timeoutMs: 25,
      fetch: hangingFetch,
    });
    const started = performance.now();
    await gate.assertAllowed('https://slow.test/one');
    await gate.assertAllowed('https://slow.test/two');
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
