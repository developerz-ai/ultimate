// `x deploy verify` against a real socket: `Bun.serve` on loopback answers real headers, and time
// moves only when the command sleeps. The queue half is `cmd-deploy-verify-queues.test.ts`.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { BUILD_ID_HEADER } from '@ultimat3/core';
import { allowHost } from '@ultimat3/testing';
import { runDeployVerify } from './cmd-deploy-verify';
import {
  appRoot,
  BUILD,
  codes,
  contextFor,
  FAST,
  frozen,
  OLD,
  origin,
  removeAppRoots,
  servers,
  stopOrigins,
} from './deploy-verify-fixture';

afterAll(removeAppRoots);
afterEach(stopOrigins);

describe('x deploy verify · the build and its window', () => {
  test('old then new passes only after --window of consecutive new answers', async () => {
    const server = origin([
      [200, OLD],
      [200, OLD],
      [200, BUILD],
      [200, BUILD],
      [200, BUILD],
    ]);
    const deps = frozen();
    const result = await runDeployVerify(
      contextFor(['--url', server.url, '--build', BUILD, ...FAST], appRoot()),
      deps,
    );
    expect(result.ok).toBe(true);
    // Two old, then the new one's first answer opens it and the third closes it: not one fewer.
    expect(server.requests()).toBe(5);
    expect(result.data).toMatchObject({
      build: BUILD,
      windowMs: 10_000,
      samples: { total: 5, good: 3, byBuild: { [OLD]: 2, [BUILD]: 3 }, byStatus: { '200': 5 } },
    });
  });

  test('a mix of old and new restarts the window, and the wait runs out as unstable', async () => {
    const server = origin([
      [200, BUILD],
      [200, OLD],
    ]);
    const result = await runDeployVerify(
      contextFor(['--url', server.url, '--build', BUILD, ...FAST], appRoot()),
      frozen(),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['X_DEPLOY_UNSTABLE']);
    expect(result.data).toMatchObject({ samples: { good: 1, byBuild: { [OLD]: 6 } } });
  });

  test('--window 0 is a value: one good answer passes, with no sleep', async () => {
    const server = origin([[200, BUILD]]);
    const deps = frozen();
    const result = await runDeployVerify(
      contextFor(['--url', server.url, '--build', BUILD, '--window', '0'], appRoot()),
      deps,
    );
    expect(result.ok).toBe(true);
    expect(deps.sleeps).toEqual([]);
    expect(server.requests()).toBe(1);
  });

  test('--timeout ends the whole wait, and the last sleep stops at it', async () => {
    const server = origin([[200, OLD]]);
    const deps = frozen();
    const result = await runDeployVerify(
      contextFor(
        [
          '--url',
          server.url,
          '--build',
          BUILD,
          '--window',
          '5s',
          '--interval',
          '4s',
          '--timeout',
          '10s',
        ],
        appRoot(),
      ),
      deps,
    );
    expect(codes(result)).toEqual(['X_DEPLOY_BUILD_MISMATCH']);
    expect(deps.sleeps).toEqual([4_000, 4_000, 2_000]);
    expect(result.findings?.[0]?.meta).toMatchObject({ byBuild: { [OLD]: 4 } });
  });

  test('the sample the last sleep lands on the deadline still gets time to be answered', async () => {
    const slow = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch() {
        // real-clock: this server answers late on purpose, against the sample's own signal.
        await Bun.sleep(20);
        return new Response('{}', { headers: { [BUILD_ID_HEADER]: OLD } });
      },
    });
    servers.push(slow);
    allowHost(`127.0.0.1:${slow.port}`);
    const result = await runDeployVerify(
      contextFor(
        [
          '--url',
          `http://127.0.0.1:${slow.port}`,
          '--build',
          BUILD,
          '--window',
          '0',
          '--interval',
          '5s',
          '--timeout',
          '5s',
        ],
        appRoot(),
      ),
      frozen(),
    );
    expect(result.data).toMatchObject({ samples: { byStatus: { '200': 2 } } });
  });

  test('a 2xx with no header is unstamped, and the fix is the build that stamps it', async () => {
    const server = origin([[200, null]]);
    const result = await runDeployVerify(
      contextFor(['--url', server.url, '--build', BUILD, ...FAST], appRoot()),
      frozen(),
    );
    expect(codes(result)).toEqual(['X_DEPLOY_BUILD_UNSTAMPED']);
    expect(result.findings?.[0]?.fix).toContain('x build --target docker');
  });

  test('a redirect is refused, never followed, and tallied as what it is', async () => {
    const target = origin([[200, BUILD]]);
    const redirecting = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response(null, { status: 302, headers: { location: `${target.url}/readyz` } }),
    });
    servers.push(redirecting);
    allowHost(`127.0.0.1:${redirecting.port}`);
    const result = await runDeployVerify(
      contextFor(
        ['--url', `http://127.0.0.1:${redirecting.port}`, '--build', BUILD, ...FAST],
        appRoot(),
      ),
      frozen(),
    );
    expect(target.requests()).toBe(0);
    expect(codes(result)).toEqual(['X_DEPLOY_BUILD_MISMATCH']);
    expect(result.data).toMatchObject({ samples: { byStatus: { '302': 7 } } });
  });

  test('every sample is a new connection: the load balancer gets to choose again', async () => {
    const server = origin([[200, BUILD]]);
    await runDeployVerify(
      contextFor(['--url', server.url, '--build', BUILD, ...FAST], appRoot()),
      frozen(),
    );
    expect(server.ports.length).toBe(3);
    expect(new Set(server.ports).size).toBe(3);
  });

  test('nothing listening is a tallied sample, not a crash, and names what failed', async () => {
    const server = origin([[200, BUILD]]);
    const { url } = server;
    for (const live of servers.splice(0)) live.stop(true);
    const result = await runDeployVerify(
      contextFor(['--url', url, '--build', BUILD, ...FAST], appRoot()),
      frozen(),
    );
    expect(codes(result)).toEqual(['X_DEPLOY_BUILD_MISMATCH']);
    expect(result.data).toMatchObject({ samples: { byStatus: { unreachable: 7 } } });
    expect(typeof result.findings?.[0]?.meta?.['lastFailure']).toBe('string');
  });

  test('a cached /readyz naming the build is not the fleet answering: red, and asked uncached', async () => {
    const server = origin([[200, BUILD]], { age: '86400' });
    const result = await runDeployVerify(
      contextFor(['--url', server.url, '--build', BUILD, ...FAST], appRoot()),
      frozen(),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['X_DEPLOY_UNSTABLE']);
    expect(result.data).toMatchObject({ samples: { good: 0, cached: 7 } });
    expect(server.asked[0]?.get('cache-control')).toBe('no-cache');
    expect(server.asked[0]?.get('pragma')).toBe('no-cache');
  });

  test('the build defaults to x.manifest.json', async () => {
    const server = origin([[200, BUILD]]);
    const result = await runDeployVerify(
      contextFor(['--url', server.url, '--window', '0'], appRoot({ buildId: BUILD })),
      frozen(),
    );
    expect(result.data).toMatchObject({ build: BUILD });
    expect(result.ok).toBe(true);
  });
});
