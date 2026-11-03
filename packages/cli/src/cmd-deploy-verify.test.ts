// `x deploy verify` against a real socket: `Bun.serve` on loopback answers real headers, and time
// moves only when the command sleeps. The queue half reads rows handed in; the statements behind
// them are `cmd-deploy-verify.live.test.ts`'s.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp or recursive remove; these fixtures are synchronous.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { BUILD_ID_HEADER, frozenClock } from '@ultimat3/core';
import type { QueueDemand, WorkerRecord } from '@ultimat3/jobs';
import { allowHost } from '@ultimat3/testing';
import { REQUIRED_BUN } from './app-root';
import type { DeployVerifyDeps } from './cmd-deploy-verify';
import { runDeployVerify } from './cmd-deploy-verify';
import type { CommandContext } from './command';
import type { CommandResult } from './output';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const BUILD = 'b-new';
const OLD = 'b-old';

const madeDirs: string[] = [];
const servers: { stop(force?: boolean): unknown }[] = [];
afterAll(() => {
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function appRoot(manifest: unknown = { buildId: BUILD }): string {
  const dir = mkdtempSync(join(tmpdir(), 'x-deploy-verify-'));
  madeDirs.push(dir);
  writeFileSync(join(dir, 'app.config.ts'), "export const config = { name: 'demo-app' };\n");
  if (manifest !== null) writeFileSync(join(dir, 'x.manifest.json'), JSON.stringify(manifest));
  return dir;
}

/** One planned answer per request, the last repeated: `[status, build]`. */
type Answer = readonly [number, string | null];

function origin(answers: readonly Answer[], extra: Readonly<Record<string, string>> = {}) {
  const ports: number[] = [];
  const asked: Headers[] = [];
  let served = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, self) {
      ports.push(self.requestIP(request)?.port ?? 0);
      asked.push(request.headers);
      const [status, build] = answers[Math.min(served, answers.length - 1)] ?? [500, null];
      served += 1;
      const path = new URL(request.url).pathname;
      if (path !== '/readyz') return new Response('wrong path', { status: 404 });
      return new Response('{}', {
        status,
        headers: { ...extra, ...(build === null ? {} : { [BUILD_ID_HEADER]: build }) },
      });
    },
  });
  servers.push(server);
  // A bare `Bun.serve` announces nothing, so the seal is told this port and no other.
  allowHost(`127.0.0.1:${server.port}`);
  return { url: `http://127.0.0.1:${server.port}`, ports, asked, requests: () => served };
}

function contextFor(argv: readonly string[], cwd: string, env = {}): CommandContext {
  return {
    args: parseArgs(['deploy', 'verify', ...argv], SPECS),
    cwd,
    runner: () => expect.unreachable('x deploy verify spawns nothing'),
    env,
    bunVersion: REQUIRED_BUN,
  };
}

/** The frozen clock the command waits on: a sleep advances it and returns at once. */
function frozen(over: Partial<DeployVerifyDeps> = {}): DeployVerifyDeps & { sleeps: number[] } {
  const clock = frozenClock(0);
  const sleeps: number[] = [];
  return {
    clock,
    sleeps,
    sleep(ms) {
      sleeps.push(ms);
      clock.advance(ms);
      return Promise.resolve();
    },
    expectedQueues: () => expect.unreachable('no DATABASE_URL, so the app is never loaded'),
    openQueue: () => expect.unreachable('no DATABASE_URL, so no database is ever opened'),
    ...over,
  };
}

const worker = (over: Partial<WorkerRecord> = {}): WorkerRecord => ({
  id: 'w1',
  host: 'pod-1',
  startedAt: 0,
  heartbeatAt: 0,
  queues: ['mail'],
  concurrency: 1,
  inFlight: [],
  build: BUILD,
  ...over,
});

/** The queue half, handed in: `rows(n)` answers the n-th read. */
function queueDeps(input: {
  /** An `Error` is the read failing: the driver's own rejection, handed to the command. */
  readonly rows: (read: number) => readonly WorkerRecord[] | Error;
  readonly demand?: readonly QueueDemand[];
  readonly expected?: readonly string[];
}): Pick<DeployVerifyDeps, 'expectedQueues' | 'openQueue'> & { closed: () => number } {
  let reads = 0;
  let closed = 0;
  return {
    closed: () => closed,
    expectedQueues: () => Promise.resolve({ queues: input.expected ?? ['mail'], findings: [] }),
    openQueue: () =>
      Promise.resolve({
        workers() {
          reads += 1;
          const rows = input.rows(reads);
          return rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows);
        },
        demand: () => Promise.resolve(input.demand ?? []),
        close() {
          closed += 1;
          return Promise.resolve();
        },
      }),
  };
}

const DB = { DATABASE_URL: 'postgres://db.invalid/app' };
const codes = (result: CommandResult) => result.findings?.map((finding) => finding.code);
const FAST = ['--window', '10s', '--interval', '5s', '--timeout', '30s'];

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

describe('x deploy verify · the queues', () => {
  const held = ['--build', BUILD, ...FAST];

  test('no DATABASE_URL: graded false, the summary says so, nothing embedded is opened', async () => {
    const server = origin([[200, BUILD]]);
    const root = appRoot();
    // `frozen()` fails the test if the app is loaded or a database opened.
    const result = await runDeployVerify(
      contextFor(['--url', server.url, ...held], root, { DATABASE_URL: '  ' }),
      frozen(),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      queues: { graded: false, served: [], unserved: [], idle: [] },
    });
    expect(result.summary).toContain('NOT graded');
    expect(result.summary).toContain('DATABASE_URL');
    // `resolveServices` would have created it, to boot PGlite under it.
    expect(existsSync(join(root, '.x'))).toBe(false);
  });

  test('a queue with no worker row fails after the wait, naming it', async () => {
    const server = origin([[200, BUILD]]);
    const queue = queueDeps({ rows: () => [] });
    const result = await runDeployVerify(
      contextFor(['--url', server.url, ...held], appRoot(), DB),
      frozen(queue),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['X_DEPLOY_QUEUE_UNSERVED']);
    expect(result.findings?.[0]?.cause).toContain('"mail"');
    expect(result.findings?.[0]?.meta).toMatchObject({ queue: 'mail', builds: [] });
    expect(queue.closed()).toBe(1);
  });

  test('a worker of the previous build does not serve, and the finding names its build', async () => {
    const server = origin([[200, BUILD]]);
    const result = await runDeployVerify(
      contextFor(['--url', server.url, ...held], appRoot(), DB),
      frozen(queueDeps({ rows: () => [worker({ build: OLD })] })),
    );
    expect(codes(result)).toEqual(['X_DEPLOY_QUEUE_UNSERVED']);
    expect(result.findings?.[0]?.cause).toContain(OLD);
    expect(result.data).toMatchObject({
      queues: { graded: true, unserved: [{ queue: 'mail', builds: [OLD], depth: 0 }] },
    });
  });

  test('a worker roll that lands inside --timeout passes: the two rolls are not simultaneous', async () => {
    const server = origin([[200, BUILD]]);
    const deps = frozen(
      queueDeps({ rows: (read) => (read < 3 ? [worker({ build: OLD })] : [worker()]) }),
    );
    const result = await runDeployVerify(
      contextFor(['--url', server.url, ...held], appRoot(), DB),
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ queues: { graded: true, served: ['mail'] } });
  });

  test('a failed read keeps the last grade and reads again next interval', async () => {
    const server = origin([[200, BUILD]]);
    const flaky = queueDeps({
      rows: (read) => {
        if (read === 2) return new TypeError('connection reset');
        return read < 3 ? [worker({ build: OLD })] : [worker()];
      },
    });
    const result = await runDeployVerify(
      contextFor(['--url', server.url, ...held], appRoot(), DB),
      frozen(flaky),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ queues: { served: ['mail'] } });
  });

  test('every read failing is an X_* finding naming the last failure, never a raw throw', async () => {
    const server = origin([[200, BUILD]]);
    const down = queueDeps({
      rows: () => new TypeError('connection reset'),
    });
    const result = await runDeployVerify(
      contextFor(['--url', server.url, ...held], appRoot(), DB),
      frozen(down),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['X_DB_UNAVAILABLE']);
    expect(result.findings?.[0]?.cause).toContain('connection reset');
    expect(result.data).toMatchObject({ queues: { graded: false } });
    expect(down.closed()).toBe(1);
  });

  test('--idle-ok with an empty queue passes as idle, and with work waiting fails', async () => {
    const server = origin([[200, BUILD]]);
    const argv = ['--url', server.url, ...held, '--idle-ok', 'mail'];
    const idle = await runDeployVerify(
      contextFor(argv, appRoot(), DB),
      frozen(queueDeps({ rows: () => [] })),
    );
    expect(idle.data).toMatchObject({ queues: { graded: true, idle: ['mail'] } });
    expect(idle.ok).toBe(true);
    const busy = await runDeployVerify(
      contextFor(argv, appRoot(), DB),
      frozen(queueDeps({ rows: () => [], demand: [{ queue: 'mail', demand: 1 }] })),
    );
    expect(codes(busy)).toEqual(['X_DEPLOY_QUEUE_UNSERVED']);
  });

  test('--idle-ok naming a queue this app does not have is refused before any sample', async () => {
    const server = origin([[200, BUILD]]);
    await expect(
      runDeployVerify(
        contextFor(['--url', server.url, ...held, '--idle-ok', 'mial'], appRoot(), DB),
        frozen(queueDeps({ rows: () => [] })),
      ),
    ).rejects.toMatchObject({ code: 'X_CLI_BAD_FLAG' });
    expect(server.requests()).toBe(0);
  });

  test('an app that would not load fails with its own finding: a partial set grades nothing', async () => {
    const server = origin([[200, BUILD]]);
    const finding = {
      code: 'X_APP_LOAD_FAILED',
      cause: 'a module threw',
      fix: 'x manifest --json',
    };
    const result = await runDeployVerify(
      contextFor(['--url', server.url, ...held], appRoot(), DB),
      frozen({
        ...queueDeps({ rows: () => [] }),
        expectedQueues: () => Promise.resolve({ queues: [], findings: [finding] }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['X_APP_LOAD_FAILED']);
    expect(server.requests()).toBe(0);
  });

  test('a window that never closed reads no worker row', async () => {
    const server = origin([[200, OLD]]);
    const result = await runDeployVerify(
      contextFor(['--url', server.url, ...held], appRoot(), DB),
      frozen({
        ...queueDeps({ rows: () => [] }),
        openQueue: () => expect.unreachable('the build never answered'),
      }),
    );
    expect(codes(result)).toEqual(['X_DEPLOY_BUILD_MISMATCH']);
    expect(result.data).toMatchObject({ queues: { graded: false } });
  });
});
