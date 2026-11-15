// The test stack, found or started: every verdict `ensureTestServices` can reach, over a throwaway
// root and an injected runner and probe — no container is ever started here.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no `Bun.*` equivalent for either: `mkdtemp`/`rm` own a throwaway root's lifetime.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import type { ExecOptions, ExecResult, Runner } from './exec';
import { ensureTestServices, postgresLogin, SERVICES_UP, tcpReachable } from './verify-services';

const DB = 'postgres://shop:shop-test@127.0.0.1:55432/postgres';
const ENV_FILE = `# comment\nTEST_DATABASE_URL=${DB}\nTEST_REDIS_URL=redis://127.0.0.1:56379\n`;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function stackRoot(files: { compose?: boolean; env?: string } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'x-verify-services-'));
  roots.push(root);
  if (files.compose !== false) await Bun.write(join(root, 'docker/docker-compose.test.yml'), '');
  if (files.env !== undefined) await Bun.write(join(root, 'docker/test-services.env'), files.env);
  return root;
}

const result = (code: number, stderr = ''): ExecResult => ({
  command: [],
  code,
  ok: code === 0,
  stdout: '',
  stderr,
  durationMs: 0,
});

function recording(answer: () => Promise<ExecResult>) {
  const calls: { command: readonly string[]; options: ExecOptions }[] = [];
  const runner: Runner = async (command, options) => {
    calls.push({ command, options });
    return answer();
  };
  return { calls, runner };
}

const never = async (): Promise<ExecResult> => expect.unreachable('nothing may be spawned');

describe('ensureTestServices', () => {
  test('a root with no compose file is left alone', async () => {
    const root = await stackRoot({ compose: false, env: ENV_FILE });
    const { calls, runner } = recording(never);
    expect(await ensureTestServices({ root, runner, env: {}, probe: async () => false })).toEqual({
      kind: 'ambient',
    });
    expect(calls).toEqual([]);
  });

  test("a caller URL that is not the env file's is the caller's own server — never probed", async () => {
    const root = await stackRoot({ env: ENV_FILE });
    const probed: string[] = [];
    const verdict = await ensureTestServices({
      root,
      runner: recording(never).runner,
      env: { TEST_DATABASE_URL: 'postgres://elsewhere:5432/x' },
      probe: async (url) => {
        probed.push(url);
        return false;
      },
    });
    expect(verdict).toEqual({ kind: 'ambient' });
    expect(probed).toEqual([]);
  });

  test('a stack already listening: its env for every key the caller left unset, nothing started', async () => {
    const root = await stackRoot({ env: ENV_FILE });
    const { calls, runner } = recording(never);
    const verdict = await ensureTestServices({
      root,
      runner,
      env: { TEST_REDIS_URL: 'redis://mine:6379' },
      probe: async (url) => url === DB,
      login: async () => 'ok',
    });
    expect(verdict).toEqual({ kind: 'reachable', env: { TEST_DATABASE_URL: DB } });
    expect(calls).toEqual([]);
  });

  // Two apps on one machine, one port: B's suites would run against A's container and fail on a
  // password, or — worse — pass against a database that is not theirs. Never run against it.
  test('something answers but refuses our login: not our database, nothing started or handed on', async () => {
    const root = await stackRoot({ env: ENV_FILE });
    const { calls, runner } = recording(never);
    const verdict = await ensureTestServices({
      root,
      runner,
      env: {},
      probe: async () => true,
      login: async () => 'refused',
    });
    if (verdict.kind !== 'unavailable') return expect.unreachable(`verdict was ${verdict.kind}`);
    expect(verdict.finding.code).toBe('X_TEST_SERVICES_UNAVAILABLE');
    expect(verdict.finding.cause).toContain('127.0.0.1:55432');
    expect(verdict.finding.fix).toStartWith('docker ps --filter publish=55432');
    expect(calls).toEqual([]);
  });

  test('nothing answers: the compose file is started, from the root, with --wait', async () => {
    const root = await stackRoot({ env: ENV_FILE });
    const { calls, runner } = recording(async () => result(0));
    const verdict = await ensureTestServices({ root, runner, env: {}, probe: async () => false });
    expect(calls.map((call) => [call.command, call.options.cwd])).toEqual([
      [['docker', 'compose', '-f', 'docker/docker-compose.test.yml', 'up', '-d', '--wait'], root],
    ]);
    expect(verdict).toEqual({
      kind: 'started',
      env: { TEST_DATABASE_URL: DB, TEST_REDIS_URL: 'redis://127.0.0.1:56379' },
    });
  });

  test('compose exits non-zero: a coded finding whose fix is the command itself', async () => {
    const root = await stackRoot({ env: ENV_FILE });
    const { runner } = recording(async () => result(1, 'Cannot connect to the Docker daemon'));
    const verdict = await ensureTestServices({ root, runner, env: {}, probe: async () => false });
    if (verdict.kind !== 'unavailable') return expect.unreachable(`verdict was ${verdict.kind}`);
    expect(verdict.finding.code).toBe('X_TEST_SERVICES_UNAVAILABLE');
    expect(verdict.finding.cause).toContain('Cannot connect to the Docker daemon');
    expect(verdict.finding.fix.startsWith(SERVICES_UP.join(' '))).toBe(true);
  });

  test('no docker on PATH: the runner refusal becomes the same finding, never a throw', async () => {
    const root = await stackRoot({ env: ENV_FILE });
    const runner: Runner = async () => {
      throw new UltimateError({
        code: 'X_CLI_UNEXPECTED',
        cause: 'no docker',
        fix: 'command -v docker',
      });
    };
    const verdict = await ensureTestServices({ root, runner, env: {}, probe: async () => false });
    if (verdict.kind !== 'unavailable') return expect.unreachable(`verdict was ${verdict.kind}`);
    expect(verdict.finding.cause).toContain('no docker');
  });
});

describe('postgresLogin', () => {
  test('a port with no Postgres behind it is unknown, never refused: only a server says no', async () => {
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data: () => undefined },
    });
    const url = `postgres://u:p@127.0.0.1:${String(server.port)}/postgres`;
    server.stop(true);
    expect(await postgresLogin(url)).toBe('unknown');
  });
});

describe('tcpReachable', () => {
  test('a listening port answers, and the same port closed does not', async () => {
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data: () => undefined },
    });
    const url = `postgres://u:p@127.0.0.1:${String(server.port)}/postgres`;
    expect(await tcpReachable(url)).toBe(true);
    server.stop(true);
    expect(await tcpReachable(url)).toBe(false);
  });

  test('a URL that does not parse is unreachable, not a throw', async () => {
    expect(await tcpReachable('not a url')).toBe(false);
  });
});
