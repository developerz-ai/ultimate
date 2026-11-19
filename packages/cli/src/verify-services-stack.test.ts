// Whose test stack this is: read from the labels compose put on its containers, so a stack another
// checkout started is reused only when it is the same app, or when the caller said so.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no `Bun.*` equivalent: `mkdtemp`/`rm` own a throwaway root's lifetime.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { ExecOptions, ExecResult, Runner } from './exec';
import { TEST_COMPOSE_PATH, TEST_ENV_PATH } from './templates/scaffold-test-services';
import { ensureTestServices, SERVICES_UP } from './verify-services';
import { psLine } from './verify-services-fixture';
import { readStack, relationTo, SERVICES_LIST, SHARED_ENV } from './verify-services-stack';

const DB = 'postgres://shop:shop-test@127.0.0.1:55432/postgres';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function checkout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'x-stack-'));
  roots.push(root);
  await mkdir(join(root, 'docker'));
  await Bun.write(join(root, TEST_COMPOSE_PATH), '');
  await Bun.write(join(root, TEST_ENV_PATH), `TEST_DATABASE_URL=${DB}\n`);
  return root;
}

const done = (command: readonly string[], stdout: string, code = 0): ExecResult => ({
  command,
  code,
  ok: code === 0,
  stdout,
  stderr: '',
  durationMs: 0,
});

/** Docker and git, faked: `ps` answers `stack`, and `identity` maps a directory to its git facts. */
function machine(input: {
  readonly stack: () => string;
  readonly identity?: Readonly<Record<string, { root?: string; origin?: string }>>;
}) {
  const calls: { command: readonly string[]; options: ExecOptions }[] = [];
  const runner: Runner = async (command, options) => {
    calls.push({ command, options });
    if (command.join(' ') === SERVICES_LIST.join(' ')) return done(command, input.stack());
    if (command[0] === 'git') {
      const facts = input.identity?.[options.cwd];
      const value = command.includes('rev-list') ? facts?.root : facts?.origin;
      return value === undefined ? done(command, '', 128) : done(command, `${value}\n`);
    }
    return done(command, '');
  };
  return { calls, runner };
}

const up = (calls: readonly { command: readonly string[] }[]): number =>
  calls.filter((call) => call.command.join(' ') === SERVICES_UP.join(' ')).length;

const ensure = (root: string, runner: Runner, env: Record<string, string> = {}) =>
  ensureTestServices({ root, runner, env, probe: async () => true, login: async () => 'ok' });

describe('readStack', () => {
  test('reads the project, the services and the checkout that started them', async () => {
    const root = await checkout();
    const { runner } = machine({
      stack: () =>
        `${psLine('shop-test', 'redis', root)}\n${psLine('shop-test', 'postgres', root)}`,
    });
    expect(await readStack(root, runner)).toEqual({
      answered: true,
      stack: { project: 'shop-test', services: ['postgres', 'redis'], roots: [root] },
    });
  });

  test('accepts the JSON array older compose prints', async () => {
    const root = await checkout();
    const line = JSON.parse(psLine('shop-test', 'redis', root)) as unknown;
    const { runner } = machine({ stack: () => JSON.stringify([line]) });
    expect((await readStack(root, runner)).stack?.project).toBe('shop-test');
  });

  test('no container is an answer; docker failing is not', async () => {
    const root = await checkout();
    expect(await readStack(root, machine({ stack: () => '' }).runner)).toEqual({ answered: true });
    const broken: Runner = async (command) => done(command, '', 1);
    expect(await readStack(root, broken)).toEqual({ answered: false });
  });
});

describe('relationTo', () => {
  const stackOf = (...owners: readonly string[]) => ({
    project: 'shop-test',
    services: ['postgres'],
    roots: owners,
  });

  test('its own stack is simply ours, whichever path reached the checkout', async () => {
    const root = await checkout();
    const { runner } = machine({ stack: () => '' });
    expect(await relationTo(stackOf(root), root, runner, {})).toEqual({ kind: 'own' });
  });

  test('a checkout that is gone left the stack to whoever comes next', async () => {
    const root = await checkout();
    const { runner } = machine({ stack: () => '' });
    expect(await relationTo(stackOf('/no/such/checkout'), root, runner, {})).toEqual({
      kind: 'own',
    });
  });

  test('another clone of one app is a named share, by root commit or by origin', async () => {
    const [root, clone] = [await checkout(), await checkout()];
    for (const identity of [
      { [root]: { root: 'abc' }, [clone]: { root: 'abc' } },
      { [root]: { root: 'r1', origin: 'o' }, [clone]: { root: 'r2', origin: 'o' } },
    ]) {
      const { runner } = machine({ stack: () => '', identity });
      expect(await relationTo(stackOf(clone), root, runner, {})).toEqual({
        kind: 'shared',
        with: clone,
        why: 'same-app',
      });
    }
  });

  test('two apps that share only a name are a collision', async () => {
    const [root, other] = [await checkout(), await checkout()];
    const { runner } = machine({
      stack: () => '',
      identity: { [root]: { root: 'mine' }, [other]: { root: 'theirs' } },
    });
    expect(await relationTo(stackOf(other), root, runner, {})).toEqual({
      kind: 'collision',
      with: other,
    });
  });

  test('checkouts git cannot identify are never assumed to be one app', async () => {
    const [root, other] = [await checkout(), await checkout()];
    const { runner } = machine({ stack: () => '' });
    expect((await relationTo(stackOf(other), root, runner, {})).kind).toBe('collision');
  });

  test('saying so makes the share intended', async () => {
    const [root, other] = [await checkout(), await checkout()];
    const { runner } = machine({ stack: () => '' });
    expect(await relationTo(stackOf(other), root, runner, { [SHARED_ENV]: '1' })).toEqual({
      kind: 'shared',
      with: other,
      why: 'declared',
    });
  });
});

describe('ensureTestServices and the stack it finds', () => {
  test("another app's stack under this name is refused before compose can touch it", async () => {
    const [root, other] = [await checkout(), await checkout()];
    const { calls, runner } = machine({
      stack: () => psLine('shop-test', 'postgres', other),
      identity: { [root]: { root: 'mine' }, [other]: { root: 'theirs' } },
    });
    const verdict = await ensure(root, runner);
    if (verdict.kind !== 'unavailable') expect.unreachable(verdict.kind);
    expect(verdict.finding.code).toBe('X_TEST_SERVICES_UNAVAILABLE');
    expect(verdict.finding.cause).toContain(other);
    expect(verdict.finding.cause).toContain('shop-test');
    expect(verdict.finding.fix).toContain(SHARED_ENV);
    expect(up(calls)).toBe(0);
  });

  test('a collision that only appears after a cold start is refused too', async () => {
    const [root, other] = [await checkout(), await checkout()];
    let started = false;
    const base = machine({
      stack: () => (started ? psLine('shop-test', 'postgres', other) : ''),
      identity: { [root]: { root: 'mine' }, [other]: { root: 'theirs' } },
    });
    const runner: Runner = (command, options) => {
      if (command.join(' ') === SERVICES_UP.join(' ')) started = true;
      return base.runner(command, options);
    };
    expect((await ensure(root, runner)).kind).toBe('unavailable');
  });

  test('its own stack is reported as reused, with the project', async () => {
    const root = await checkout();
    const { runner } = machine({ stack: () => psLine('shop-test', 'postgres', root) });
    const verdict = await ensure(root, runner);
    if (verdict.kind !== 'reachable') expect.unreachable(verdict.kind);
    expect(verdict.stack).toEqual({ project: 'shop-test', state: 'reused' });
  });

  test('a clone of the same app shares it, and the verdict says with whom', async () => {
    const [root, clone] = [await checkout(), await checkout()];
    const { calls, runner } = machine({
      stack: () => psLine('shop-test', 'postgres', clone),
      identity: { [root]: { root: 'abc' }, [clone]: { root: 'abc' } },
    });
    const verdict = await ensure(root, runner);
    if (verdict.kind !== 'reachable') expect.unreachable(verdict.kind);
    expect(verdict.stack).toEqual({
      project: 'shop-test',
      state: 'shared',
      with: clone,
      why: 'same-app',
    });
    expect(up(calls)).toBe(1);
  });
});
