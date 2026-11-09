// The transport ceiling: the most any route reads. Bun's own `maxRequestBodySize` was left at its
// 128 MiB default, so a signed upload past it got Bun's empty, uncoded 413 before framework code
// ran. The ceiling is config now, and over it the answer is `X_BODY_TOO_LARGE` — declared or
// streamed. The socket half (Bun's limit really lifted) is `e2e/body-ceiling.e2e.test.ts`.
import { describe, expect, test } from 'bun:test';
import { BUN_MAX_REQUEST_BODY_SIZE, DEFAULT_MAX_REQUEST_BODY_BYTES } from './body-ceiling';
import { defineHttpConfig } from './config';
import { textResponse } from './response';
import type { Route } from './router';
import { httpServer } from './server';

const SCOPED = { rateLimit: { scope: 'process' as const } };

describe('maxRequestBodyBytes', () => {
  test("defaults to Bun's own former default, so an app that says nothing changes nothing", () => {
    expect(DEFAULT_MAX_REQUEST_BODY_BYTES).toBe(128 * 1024 * 1024);
    expect(defineHttpConfig(SCOPED).maxRequestBodyBytes).toBe(DEFAULT_MAX_REQUEST_BODY_BYTES);
  });

  test('is never below bodyLimitBytes — an RPC body the config allows is never refused under it', () => {
    const config = defineHttpConfig({
      ...SCOPED,
      bodyLimitBytes: 4096,
      maxRequestBodyBytes: 1024,
    });
    expect(config.maxRequestBodyBytes).toBe(4096);
  });

  test.each([Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY])(
    'maxRequestBodyBytes: %p is X_CONFIG_INVALID',
    (value) => {
      expect(() => defineHttpConfig({ ...SCOPED, maxRequestBodyBytes: value })).toThrow(
        /X_CONFIG_INVALID/,
      );
    },
  );

  test("Bun's limit is lifted above every ceiling a config can declare", () => {
    expect(BUN_MAX_REQUEST_BODY_SIZE).toBeGreaterThanOrEqual(Number.MAX_SAFE_INTEGER);
  });
});

describe('over the ceiling', () => {
  let reached = 0;
  const routes: readonly Route[] = [
    {
      method: 'PUT',
      path: '/upload',
      meta: { name: 'upload', auth: 'public' },
      handler: async (request) => {
        reached += 1;
        // A raw read, as a signed-upload route does: past `bodyLimitBytes`, bounded only by the
        // ceiling.
        const bytes = await request.raw.arrayBuffer();
        return textResponse(String(bytes.byteLength));
      },
    },
  ];
  const server = () =>
    httpServer({
      routes,
      config: defineHttpConfig({
        ...SCOPED,
        dev: false,
        buildId: null,
        bodyLimitBytes: 16,
        maxRequestBodyBytes: 64,
      }),
    });
  const put = (body: BodyInit, headers: Record<string, string> = {}) =>
    server().fetch(
      new Request('http://app.test/upload', {
        method: 'PUT',
        body,
        headers: { accept: 'application/json', ...headers },
        duplex: 'half',
      } as RequestInit),
    );
  const stream = (bytes: number) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let sent = 0; sent < bytes; sent += 8) controller.enqueue(new Uint8Array(8));
        controller.close();
      },
    });

  test('a body past bodyLimitBytes and inside the ceiling reaches the handler whole', async () => {
    const response = await put(new Uint8Array(48));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('48');
  });

  test('a DECLARED length past the ceiling is a coded 413 before the handler runs', async () => {
    reached = 0;
    // A constructed Request carries no content-length of its own; a socket's does.
    const response = await put(new Uint8Array(65), { 'content-length': '65' });
    expect(response.status).toBe(413);
    const problem = (await response.json()) as { code: string };
    expect(problem.code).toBe('X_BODY_TOO_LARGE');
    expect(reached).toBe(0);
  });

  test('a STREAMED body past the ceiling is a coded 413 too, never read in full', async () => {
    const response = await put(stream(128));
    expect(response.status).toBe(413);
    expect(((await response.json()) as { code: string }).code).toBe('X_BODY_TOO_LARGE');
  });

  test('a streamed body inside the ceiling is read whole', async () => {
    const response = await put(stream(64));
    expect(await response.text()).toBe('64');
  });
});
