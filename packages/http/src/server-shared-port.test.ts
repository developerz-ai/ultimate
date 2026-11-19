// The web listener asks Bun for `reusePort` through core's seam and nowhere else: present only for
// a supervised child on Linux, and the ONLY difference that supervision makes to the options.

import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { resetLifecycle } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { httpServer } from './server';

beforeEach(resetLifecycle);
afterEach(() => {
  delete process.env['ULTIMATE_CHILD'];
  resetLifecycle();
});

/** The options object `Bun.serve` received for one real start on an ephemeral loopback port. */
async function serveOptionsUnder(child: string | undefined): Promise<Record<string, unknown>> {
  resetLifecycle();
  if (child === undefined) delete process.env['ULTIMATE_CHILD'];
  else process.env['ULTIMATE_CHILD'] = child;
  const serve = spyOn(Bun, 'serve');
  try {
    const handle = httpServer({
      routes: [],
      role: 'web',
      config: defineHttpConfig({
        rateLimit: { scope: 'process' },
        port: 0,
        hostname: '127.0.0.1',
        buildId: null,
      }),
    });
    handle.start();
    await handle.stop();
    const options = serve.mock.calls[0]?.[0];
    if (options === undefined) return expect.unreachable('Bun.serve was not called');
    return options as unknown as Record<string, unknown>;
  } finally {
    serve.mockRestore();
  }
}

test('an unsupervised web process never sets reusePort', async () => {
  expect(Object.hasOwn(await serveOptionsUnder(undefined), 'reusePort')).toBe(false);
});

test('a supervised child shares the port on Linux, and the key is absent elsewhere', async () => {
  const options = await serveOptionsUnder('0/2');
  if (process.platform === 'linux') expect(options['reusePort']).toBe(true);
  else expect(Object.hasOwn(options, 'reusePort')).toBe(false);
});

test('supervision changes nothing else about the serve options', async () => {
  const alone = await serveOptionsUnder(undefined);
  const supervised = await serveOptionsUnder('1/2');
  const { reusePort: _shared, ...rest } = supervised;
  expect(Object.keys(rest).sort()).toEqual(Object.keys(alone).sort());
  for (const key of ['port', 'hostname', 'development', 'idleTimeout', 'maxRequestBodySize']) {
    expect(rest[key]).toEqual(alone[key]);
  }
});
