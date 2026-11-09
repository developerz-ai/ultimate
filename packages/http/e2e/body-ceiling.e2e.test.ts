// What only a socket can prove about the transport ceiling: Bun's own `maxRequestBodySize` is
// lifted, so a body past its 128 MiB default reaches the handler when `maxRequestBodyBytes`
// allows it, and a body past the ceiling is the framework's coded 413, never Bun's empty one.
//
//   bun test packages/http/e2e
import { afterAll, describe, expect, test } from 'bun:test';
import { resetLifecycle } from '@ultimat3/core';
import { defineHttpConfig } from '../src/config';
import { textResponse } from '../src/response';
import { httpServer } from '../src/server';

const MIB = 1024 * 1024;

resetLifecycle();

const handle = httpServer({
  role: 'web',
  routes: [
    {
      method: 'PUT',
      path: '/upload',
      meta: { name: 'upload', auth: 'public' },
      // Counted, never buffered: the test is about who refuses, not about holding 129 MiB twice.
      handler: async (request) => {
        let total = 0;
        for await (const chunk of request.raw.body ?? []) total += chunk.byteLength;
        return textResponse(String(total));
      },
    },
  ],
  config: defineHttpConfig({
    rateLimit: { scope: 'process' },
    port: 0,
    hostname: '127.0.0.1',
    dev: false,
    buildId: null,
    maxRequestBodyBytes: 130 * MIB,
  }),
}).start();

afterAll(async () => {
  await handle.stop();
  resetLifecycle();
});

const put = (bytes: number) =>
  fetch(`${handle.url()}/upload`, {
    method: 'PUT',
    body: new Uint8Array(bytes),
    headers: { accept: 'application/json' },
  });

describe('the transport ceiling, over a real socket', () => {
  test("a body past Bun's 128 MiB default and inside the ceiling reaches the handler", async () => {
    const response = await put(129 * MIB);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(String(129 * MIB));
  });

  test("a body past the ceiling is X_BODY_TOO_LARGE, not Bun's uncoded 413", async () => {
    const response = await put(131 * MIB);
    expect(response.status).toBe(413);
    expect(((await response.json()) as { code: string }).code).toBe('X_BODY_TOO_LARGE');
  });
});
