// The production-image bench against a local server standing in for one `web` pod: the readiness
// wait, the load loop and the verdict — what `--pods 1` does against the Compose `web`. Pods 2..n
// are `docker compose run`, which no unit test starts; the flags are refused before any of it.

import { afterAll, describe, expect, test } from 'bun:test';
import { allowHost } from '../../packages/testing/src/sealed-network';
import { ScriptError } from '../lib/script-error';
import { benchPods, podsArgs, podsReport } from './http-prod-image.bench';

const servers: { stop(force?: boolean): unknown }[] = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

/** A pod on a free port: `/readyz` answers `ready`, `/` answers `status`. */
const pod = (status: number, readyStatus = 200): number => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === '/readyz'
        ? new Response('ok', { status: readyStatus })
        : new Response('hello', { status }),
  });
  servers.push(server);
  // The test preload seals the network; this one loopback pod is let through, by host and port.
  allowHost(`127.0.0.1:${String(server.port)}`);
  return server.port ?? 0;
};

const refusalOf = (work: Promise<unknown>) =>
  work.then(
    () => 'resolved',
    (error: unknown) => (error instanceof ScriptError ? error.code : 'not a ScriptError'),
  );

const run = { app: '/no/app', pods: 1, path: '/', seconds: 0.2, concurrency: 2 };

describe('http-prod-image bench', () => {
  test('one ready pod is loaded and its answers summed', async () => {
    const result = await benchPods({ ...run, basePort: pod(200) });
    expect(result.pods).toBe(1);
    expect(result.rps).toBeGreaterThan(0);
    expect(result.perPod[0]?.non2xx).toBe(0);
    expect(podsReport([result])[0]).toMatch(/^1 pod\(s\): \d+ req\/s, worst p50 /);
  });

  test('a pod answering 500 is a failed run, never a figure', async () => {
    expect(await refusalOf(benchPods({ ...run, basePort: pod(500) }))).toBe('X_BENCH_RUN_FAILED');
  });

  test('a pod that never reports ready is a failed run', async () => {
    const port = pod(200, 503);
    expect(await refusalOf(benchPods({ ...run, basePort: port, readyTimeoutMs: 50 }))).toBe(
      'X_BENCH_RUN_FAILED',
    );
  });

  test('flags: --app is required, pods and seconds are bounded', () => {
    const codeOf = (argv: readonly string[]) => {
      try {
        podsArgs(argv);
      } catch (error) {
        return error instanceof ScriptError ? error.code : 'not a ScriptError';
      }
      return undefined;
    };
    expect(codeOf([])).toBe('X_CLI_BAD_FLAG');
    expect(codeOf(['--app', 'a', '--pods', '9'])).toBe('X_CLI_BAD_FLAG');
    expect(codeOf(['--app', 'a', '--seconds', '5'])).toBe('X_CLI_BAD_FLAG');
    expect(podsArgs(['--app', 'a'])).toMatchObject({ podCounts: [1, 3], path: '/', seconds: 30 });
  });
});
