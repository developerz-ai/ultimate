// TEST-ONLY. The loopback origin, the frozen deps and the handed-in queue reader that
// `cmd-deploy-verify*.test.ts` drive `x deploy verify` with. Shared, so the two files cannot drift.

import { expect } from 'bun:test';
// why: Bun has no mkdtemp or recursive remove; these fixtures are synchronous.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { BUILD_ID_HEADER, frozenClock } from '@ultimat3/core';
import type { QueueDemand, WorkerRecord } from '@ultimat3/jobs';
import { allowHost } from '@ultimat3/testing';
import { REQUIRED_BUN } from './app-root';
import type { DeployVerifyDeps } from './cmd-deploy-verify';
import type { CommandContext } from './command';
import type { CommandResult } from './output';
import { parseArgs } from './parse';
import { SPECS } from './registry';

export const BUILD = 'b-new';
export const OLD = 'b-old';

const madeDirs: string[] = [];
export const servers: { stop(force?: boolean): unknown }[] = [];

/** For an `afterAll`: every app root this run made. */
export function removeAppRoots(): void {
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** For an `afterEach`: every loopback origin the test started. */
export function stopOrigins(): void {
  for (const server of servers.splice(0)) server.stop(true);
}
export function appRoot(manifest: unknown = { buildId: BUILD }): string {
  const dir = mkdtempSync(join(tmpdir(), 'x-deploy-verify-'));
  madeDirs.push(dir);
  writeFileSync(join(dir, 'app.config.ts'), "export const config = { name: 'demo-app' };\n");
  if (manifest !== null) writeFileSync(join(dir, 'x.manifest.json'), JSON.stringify(manifest));
  return dir;
}

/** One planned answer per request, the last repeated: `[status, build]`. */
export type Answer = readonly [number, string | null];

export function origin(answers: readonly Answer[], extra: Readonly<Record<string, string>> = {}) {
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

export function contextFor(argv: readonly string[], cwd: string, env = {}): CommandContext {
  return {
    args: parseArgs(['deploy', 'verify', ...argv], SPECS),
    cwd,
    runner: () => expect.unreachable('x deploy verify spawns nothing'),
    env,
    bunVersion: REQUIRED_BUN,
  };
}

/** The frozen clock the command waits on: a sleep advances it and returns at once. */
export function frozen(
  over: Partial<DeployVerifyDeps> = {},
): DeployVerifyDeps & { sleeps: number[] } {
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
    // Never, unless a test says so: a read that answers always beats it.
    expire: () => new Promise<void>(() => undefined),
    ...over,
  };
}

export const worker = (over: Partial<WorkerRecord> = {}): WorkerRecord => ({
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
export function queueDeps(input: {
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

export const DB = { DATABASE_URL: 'postgres://db.invalid/app' };
export const codes = (result: CommandResult) => result.findings?.map((finding) => finding.code);
export const FAST = ['--window', '10s', '--interval', '5s', '--timeout', '30s'];
