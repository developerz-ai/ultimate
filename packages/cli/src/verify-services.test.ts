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
const ENV_FILE = `# comment\nTEST_DATABASE_URL=${DB}\nTEST_REDIS_URL=redis://127.0.0.1:56379\nTEST_NATS_URL=nats://127.0.0.1:54222\nTEST_CA=docker/ca.crt\n`;

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

  test('Postgres already up: the idempotent up brings the rest, then every unset key is handed on', async () => {
    const root = await stackRoot({ env: ENV_FILE });
    const { calls, runner } = recording(async () => result(0));
    const verdict = await ensureTestServices({
      root,
      runner,
      env: { TEST_NATS_URL: 'nats://mine:4222' },
      probe: async (url) => url === DB,
      login: async () => 'ok',
    });
    expect(calls.map((call) => call.command).filter((one) => one.includes('up'))).toEqual([
      SERVICES_UP,
    ]);
    expect(verdict).toEqual({
      kind: 'reachable',
      env: {
        TEST_DATABASE_URL: DB,
        TEST_REDIS_URL: 'redis://127.0.0.1:56379',
        TEST_CA: 'docker/ca.crt',
      },
      startedServices: [],
    });
  });

  test('Postgres up, the rest cannot be started: only the keys whose services answer', async () => {
    const root = await stackRoot({ env: ENV_FILE });
    const { runner } = recording(async () => result(1, 'Cannot connect to the Docker daemon'));
    const verdict = await ensureTestServices({
      root,
      runner,
      env: {},
      probe: async (url) => url === DB,
      login: async () => 'ok',
    });
    // Redis and NATS answer nothing, so their suites keep skipping rather than failing to connect;
    // a value that is not a URL (a certificate path) is no service and is kept.
    expect(verdict).toEqual({
      kind: 'reachable',
      env: { TEST_DATABASE_URL: DB, TEST_CA: 'docker/ca.crt' },
      startedServices: [],
    });
  });

  test('a Postgres still starting (login unknown) is waited for by the same idempotent up', async () => {
    const root = await stackRoot({ env: ENV_FILE });
    const { calls, runner } = recording(async () => result(0));
    const verdict = await ensureTestServices({
      root,
      runner,
      env: {},
      probe: async () => true,
      login: async () => 'unknown',
    });
    expect(calls.map((call) => call.command).filter((one) => one.includes('up'))).toEqual([
      SERVICES_UP,
    ]);
    expect(verdict.kind).toBe('reachable');
  });

  test('up fails beside a concurrent run that brought the stack up: probed again, never unavailable', async () => {
    const root = await stackRoot({ env: ENV_FILE });
    let up = false;
    const runner: Runner = async () => {
      up = true;
      return result(1, 'Conflict. The container name "/shop-test-postgres-1" is already in use');
    };
    const verdict = await ensureTestServices({
      root,
      runner,
      env: {},
      probe: async (url) => up && url === DB,
      login: async () => 'ok',
    });
    expect(verdict).toEqual({
      kind: 'reachable',
      env: { TEST_DATABASE_URL: DB, TEST_CA: 'docker/ca.crt' },
      startedServices: [],
    });
  });

  test('up is bounded: --wait carries a --wait-timeout, so it cannot outlast the step', () => {
    const at = SERVICES_UP.indexOf('--wait-timeout');
    expect(SERVICES_UP).toContain('--wait');
    expect(Number(SERVICES_UP[at + 1])).toBeGreaterThan(0);
  });

  /** Answers `ps` with `before`, then `after`; `up` succeeds. */
  const composeAnswering = (before: string, after: string): Runner => {
    let upped = false;
    return async (command) => {
      if (command.includes('up')) upped = true;
      return { ...result(0), stdout: command.includes('ps') ? (upped ? after : before) : '' };
    };
  };

  test("the services this run's `up` started are named, from compose's own answer", async () => {
    const root = await stackRoot({ env: ENV_FILE });
    const verdict = await ensureTestServices({
      root,
      runner: composeAnswering('postgres\n', 'postgres\nredis\nnats\n'),
      env: {},
      probe: async () => true,
      login: async () => 'ok',
    });
    expect(verdict.kind === 'reachable' ? verdict.startedServices : []).toEqual(['nats', 'redis']);
  });

  test('a stack already wholly up: `up` changes nothing, and nothing is named', async () => {
    const root = await stackRoot({ env: ENV_FILE });
    const all = 'postgres\nredis\nnats\n';
    const verdict = await ensureTestServices({
      root,
      runner: composeAnswering(all, all),
      env: {},
      probe: async () => true,
      login: async () => 'ok',
    });
    expect(verdict.kind === 'reachable' ? verdict.startedServices : ['?']).toEqual([]);
  });

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
    expect(
      calls
        .filter((call) => call.command.includes('up'))
        .map((call) => [call.command, call.options.cwd]),
    ).toEqual([
      [
        [
          'docker',
          'compose',
          '-f',
          'docker/docker-compose.test.yml',
          'up',
          '-d',
          '--wait',
          '--wait-timeout',
          '120',
        ],
        root,
      ],
    ]);
    expect(verdict).toEqual({
      kind: 'started',
      env: {
        TEST_DATABASE_URL: DB,
        TEST_REDIS_URL: 'redis://127.0.0.1:56379',
        TEST_NATS_URL: 'nats://127.0.0.1:54222',
        TEST_CA: 'docker/ca.crt',
      },
      startedServices: [],
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
