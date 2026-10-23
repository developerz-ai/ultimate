// Bun's own 10 s idle cut, against a real socket: only a handler that is really silent for longer
// than that proves the server hands Bun the deadline-derived `idleTimeout`. Measured on Bun 1.4.2,
// the unset default closes such a socket between 11 and 13 s, so the handler sleeps 13.5 s.
//
//   bun test packages/http/e2e/idle-timeout.e2e.test.ts
import { afterAll, expect, test } from 'bun:test';
import { resetLifecycle } from '@ultimat3/core';
import { defineHttpConfig } from '../src/config';
import { textResponse } from '../src/response';
import { httpServer } from '../src/server';

const SILENT_MS = 13_500;

resetLifecycle();

const handle = httpServer({
  routes: [
    {
      method: 'GET',
      path: '/slow',
      meta: { name: 'slow', auth: 'public' },
      handler: async () => {
        await Bun.sleep(SILENT_MS);
        return textResponse('done');
      },
    },
  ],
  role: 'web',
  // The default 30 s deadline: the framework's promise that Bun's default used to break at 10.
  config: defineHttpConfig({
    rateLimit: { scope: 'process' },
    port: 0,
    hostname: '127.0.0.1',
    dev: false,
  }),
}).start();

afterAll(async () => {
  await handle.stop();
  resetLifecycle();
});

test(
  'a handler silent past the 10 s Bun default is answered, not cut, inside requestTimeoutMs',
  async () => {
    const response = await fetch(`${handle.url()}/slow`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('done');
  },
  SILENT_MS + 10_000,
);
