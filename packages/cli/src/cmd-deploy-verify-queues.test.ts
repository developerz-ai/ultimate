// `x deploy verify`'s queue half: rows handed in, the window sampled on a loopback origin, time
// moved only by the command's own sleeps. The statements behind the rows are the live suite's.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no sync existence check for a directory.
import { existsSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { WorkerRecord } from '@ultimat3/jobs';
import { runDeployVerify } from './cmd-deploy-verify';
import {
  appRoot,
  BUILD,
  codes,
  contextFor,
  DB,
  FAST,
  frozen,
  OLD,
  origin,
  queueDeps,
  removeAppRoots,
  stopOrigins,
  worker,
} from './deploy-verify-fixture';

afterAll(removeAppRoots);
afterEach(stopOrigins);

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

  test('one grade then only failed reads keeps that grade to the end: unserved, not unavailable', async () => {
    const server = origin([[200, BUILD]]);
    const result = await runDeployVerify(
      contextFor(['--url', server.url, ...held], appRoot(), DB),
      frozen(queueDeps({ rows: (read) => (read === 1 ? [] : new TypeError('connection reset')) })),
    );
    expect(codes(result)).toEqual(['X_DEPLOY_QUEUE_UNSERVED']);
    expect(result.findings?.[0]?.meta).toMatchObject({ queue: 'mail', builds: [] });
  });

  test('web rolling back while the workers roll is red: success needs both grades current', async () => {
    const server = origin([
      [200, BUILD],
      [200, BUILD],
      [200, BUILD],
      [200, OLD],
    ]);
    const result = await runDeployVerify(
      contextFor(['--url', server.url, ...held], appRoot(), DB),
      frozen(queueDeps({ rows: (read) => (read === 1 ? [] : [worker()]) })),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['X_DEPLOY_UNSTABLE']);
  });

  test('a queue read that hangs ends at --timeout, and the database is told the same bound', async () => {
    const server = origin([[200, BUILD]]);
    const bounds: number[] = [];
    const limits: number[] = [];
    let closed = 0;
    const result = await runDeployVerify(
      contextFor(['--url', server.url, ...held], appRoot(), DB),
      frozen({
        expectedQueues: () => Promise.resolve({ queues: ['mail'], findings: [] }),
        openQueue: (_url, _env, statementTimeoutMs) => {
          bounds.push(statementTimeoutMs);
          return Promise.resolve({
            workers: () => new Promise<readonly WorkerRecord[]>(() => undefined),
            demand: () => Promise.resolve([]),
            close() {
              closed += 1;
              return Promise.resolve();
            },
          });
        },
        expire: (ms) => {
          limits.push(ms);
          return Promise.resolve();
        },
      }),
    );
    expect(codes(result)).toEqual(['X_DB_UNAVAILABLE']);
    expect(result.findings?.[0]?.cause).toContain('--timeout');
    // One --interval, never the 20 s left: the sample the verdict stands on is at most that old.
    expect(bounds).toEqual([5_000]);
    expect(limits[0]).toBe(5_000);
    expect(closed).toBe(1);
  });

  test('a served grade kept through failed reads never passes: success needs a current read', async () => {
    const server = origin([
      [200, BUILD],
      [200, BUILD],
      [200, BUILD],
      [200, OLD],
      [200, BUILD],
    ]);
    const result = await runDeployVerify(
      contextFor(['--url', server.url, ...held], appRoot(), DB),
      frozen(
        queueDeps({
          rows: (read) => (read === 1 ? [worker()] : new TypeError('connection reset')),
        }),
      ),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['X_DB_UNAVAILABLE']);
    // The detail of the last grade that landed is still reported.
    expect(result.data).toMatchObject({ queues: { graded: true, served: ['mail'] } });
  });

  test('a read that lands disarms its expiry: no timer outlives the verdict', async () => {
    const server = origin([[200, BUILD]]);
    const signals: AbortSignal[] = [];
    const result = await runDeployVerify(
      contextFor(['--url', server.url, ...held], appRoot(), DB),
      frozen({
        ...queueDeps({ rows: () => [worker()] }),
        expire: (_ms, signal) => {
          signals.push(signal);
          return new Promise<void>(() => undefined);
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(signals.length).toBe(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  test('a fresh sample after the read: web rolling back during a slow read is not green', async () => {
    const server = origin([
      [200, BUILD],
      [200, BUILD],
      [200, BUILD],
      [200, OLD],
    ]);
    const result = await runDeployVerify(
      contextFor(['--url', server.url, ...held], appRoot(), DB),
      frozen(queueDeps({ rows: () => [worker()] })),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['X_DEPLOY_UNSTABLE']);
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
