// The `live` step over a fixture app with an injected runner: when the floor holds the step and no
// database answers, the gate's first child is the compose start and the suite's child sees the
// stack's env. Nothing is spawned — the runner records and answers.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no `Bun.*` equivalent for either: `mkdtemp`/`rm` own a throwaway root's lifetime.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { ExecOptions, ExecResult, Runner } from './exec';
import { withTestServices } from './verify-live';
import { SERVICES_UP } from './verify-services';
import type { VerifyContext, VerifyStep } from './verify-step';
import { bareTestStep, resetTestDiscovery, TEST_STEPS } from './verify-tests';

const DB = 'postgres://shop:shop-test@127.0.0.1:55432/postgres';

const roots: string[] = [];
afterEach(async () => {
  resetTestDiscovery();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixtureApp(floor: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'x-verify-live-'));
  roots.push(root);
  await Bun.write(join(root, 'x.verify.json'), JSON.stringify({ steps: floor }));
  await Bun.write(join(root, 'docker/docker-compose.test.yml'), 'services: {}\n');
  await Bun.write(join(root, 'docker/test-services.env'), `TEST_DATABASE_URL=${DB}\n`);
  await Bun.write(join(root, 'packages/db/src/orders.live.test.ts'), '');
  return root;
}

function recording(dockerCode = 0) {
  const calls: { command: readonly string[]; options: ExecOptions }[] = [];
  const runner: Runner = async (command, options): Promise<ExecResult> => {
    calls.push({ command, options });
    const code = command[0] === 'docker' ? dockerCode : 0;
    return { command, code, ok: code === 0, stdout: '', stderr: '', durationMs: 0 };
  };
  return { calls, runner };
}

const liveStep = (): VerifyStep => withTestServices(bareTestStep('live'), async () => false);

const ctxOf = (root: string, runner: Runner, only?: VerifyContext['only']): VerifyContext => ({
  root,
  runner,
  env: {},
  ...(only === undefined ? {} : { only }),
});

describe('the live step starts the test database it needs', () => {
  test('floor holds live, nothing answers: compose starts first, the suite sees its env', async () => {
    const root = await fixtureApp(['live']);
    const { calls, runner } = recording();
    const outcome = await liveStep().run(ctxOf(root, runner));
    expect(calls.map((call) => call.command[0])).toEqual(['docker', 'bun']);
    expect(calls[0]?.command).toEqual(SERVICES_UP);
    expect(calls[0]?.options.cwd).toBe(root);
    expect(calls[1]?.options.env?.['TEST_DATABASE_URL']).toBe(DB);
    expect(outcome.warnings?.join('\n')).toContain(
      'docker compose -f docker/docker-compose.test.yml down',
    );
  });

  test('--only live asks for it as the floor does', async () => {
    const root = await fixtureApp([]);
    const { calls, runner } = recording();
    await liveStep().run(ctxOf(root, runner, ['live']));
    expect(calls[0]?.command).toEqual(SERVICES_UP);
  });

  test('neither floor nor --only: nothing is started and the suite runs as it did', async () => {
    const root = await fixtureApp(['unit']);
    const { calls, runner } = recording();
    await liveStep().run(ctxOf(root, runner));
    expect(calls.map((call) => call.command[0])).toEqual(['bun']);
    expect(calls[0]?.options.env?.['TEST_DATABASE_URL']).toBeUndefined();
  });

  test('docker cannot start it: a warning with the code and the command, the suite still runs', async () => {
    const root = await fixtureApp(['live']);
    const { calls, runner } = recording(1);
    const outcome = await liveStep().run(ctxOf(root, runner));
    expect(calls.map((call) => call.command[0])).toEqual(['docker', 'bun']);
    expect(calls[1]?.options.env?.['TEST_DATABASE_URL']).toBeUndefined();
    const warning = outcome.warnings?.join('\n') ?? '';
    expect(warning).toContain('X_TEST_SERVICES_UNAVAILABLE');
    expect(warning).toContain(`fix: ${SERVICES_UP.join(' ')}`);
  });
});

test('the gate itself wires the live step through the wrap', () => {
  const wired = TEST_STEPS.find((candidate) => candidate.name === 'live');
  expect(wired).toBeDefined();
  expect(wired).not.toBe(bareTestStep('live'));
  expect(wired?.run.toString()).not.toBe(bareTestStep('live').run.toString());
});
