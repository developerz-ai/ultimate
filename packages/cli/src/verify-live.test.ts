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
import { runVerify } from './verify-run';
import { SERVICES_UP } from './verify-services';
import { psLine } from './verify-services-fixture';
import { SERVICES_LIST } from './verify-services-stack';
import type { VerifyContext, VerifyStep } from './verify-step';
import { bareTestStep, resetTestDiscovery, TEST_STEPS } from './verify-tests';

const DB = 'postgres://shop:shop-test@127.0.0.1:55432/postgres';

const roots: string[] = [];
afterEach(async () => {
  resetTestDiscovery();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixtureApp(
  floor: readonly string[],
  { stack = true }: { readonly stack?: boolean } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'x-verify-live-'));
  roots.push(root);
  await Bun.write(join(root, 'x.verify.json'), JSON.stringify({ steps: floor }));
  if (stack) {
    await Bun.write(join(root, 'docker/docker-compose.test.yml'), 'services: {}\n');
    await Bun.write(join(root, 'docker/test-services.env'), `TEST_DATABASE_URL=${DB}\n`);
  }
  await Bun.write(join(root, 'packages/db/src/orders.live.test.ts'), '');
  return root;
}

/** Every child recorded; `docker compose ps` answers `running.before` until `up`, then `.after`. */
function recording(dockerCode = 0, running = { before: '', after: 'postgres\n' }) {
  const calls: { command: readonly string[]; options: ExecOptions }[] = [];
  let upped = false;
  const runner: Runner = async (command, options): Promise<ExecResult> => {
    calls.push({ command, options });
    const ps = command.includes('ps');
    if (command.includes('up')) upped = true;
    const code = command[0] === 'docker' && !ps ? dockerCode : 0;
    const stdout = ps ? (upped ? running.after : running.before) : '';
    return { command, code, ok: code === 0, stdout, stderr: '', durationMs: 0 };
  };
  return { calls, runner };
}

/** The children that are not compose's own `ps` question. */
const acts = (calls: readonly { command: readonly string[] }[]) =>
  calls.filter((call) => !call.command.includes('ps'));

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
    const run = acts(calls) as typeof calls;
    expect(run.map((call) => call.command[0])).toEqual(['docker', 'bun']);
    expect(run[0]?.command).toEqual(SERVICES_UP);
    expect(run[0]?.options.cwd).toBe(root);
    expect(run[1]?.options.env?.['TEST_DATABASE_URL']).toBe(DB);
    // The database answered: a skip from here on is judged as one with it in reach.
    expect(outcome.services).toBe('reached');
    expect(outcome.warnings?.join('\n')).toContain(
      'docker compose -f docker/docker-compose.test.yml down',
    );
  });

  test('--only live asks for it as the floor does', async () => {
    const root = await fixtureApp([]);
    const { calls, runner } = recording();
    await liveStep().run(ctxOf(root, runner, ['live']));
    expect(acts(calls)[0]?.command).toEqual(SERVICES_UP);
  });

  test('neither floor nor --only: nothing is started and the suite runs as it did', async () => {
    const root = await fixtureApp(['unit']);
    const { calls, runner } = recording();
    const outcome = await liveStep().run(ctxOf(root, runner));
    expect(outcome.services).toBeUndefined();
    expect(calls.map((call) => call.command[0])).toEqual(['bun']);
    expect(calls[0]?.options.env?.['TEST_DATABASE_URL']).toBeUndefined();
  });

  test('docker cannot start it: a warning with the code and the command, the suite still runs', async () => {
    const root = await fixtureApp(['live']);
    const { calls, runner } = recording(1);
    const outcome = await liveStep().run(ctxOf(root, runner));
    const run = acts(calls) as typeof calls;
    expect(run.map((call) => call.command[0])).toEqual(['docker', 'bun']);
    expect(run[1]?.options.env?.['TEST_DATABASE_URL']).toBeUndefined();
    const warning = outcome.warnings?.join('\n') ?? '';
    expect(warning).toContain('X_TEST_SERVICES_UNAVAILABLE');
    expect(warning).toContain(`fix: ${SERVICES_UP.join(' ')}`);
    expect(outcome.services).toBe('unavailable');
  });

  test('no test stack: the caller URL is a database in reach, its absence is none', async () => {
    const root = await fixtureApp(['live'], { stack: false });
    const { runner } = recording();
    const bare = await liveStep().run(ctxOf(root, runner));
    expect(bare.services).toBeUndefined();
    const own = await liveStep().run({ ...ctxOf(root, runner), env: { TEST_DATABASE_URL: DB } });
    expect(own.services).toBe('reached');
  });
});

describe("the 'left running' warning follows what compose started, not the Postgres verdict", () => {
  const DOWN = 'docker compose -f docker/docker-compose.test.yml down';
  const reachable = (): VerifyStep =>
    withTestServices(
      bareTestStep('live'),
      async () => true,
      async () => 'ok',
    );

  test('Postgres already up, redis and nats started by this run: it says so, with the stop line', async () => {
    const root = await fixtureApp(['live']);
    const { runner } = recording(0, { before: 'postgres\n', after: 'postgres\nredis\nnats\n' });
    const outcome = await reachable().run(ctxOf(root, runner));
    const warning = outcome.warnings?.join('\n') ?? '';
    expect(warning).toContain('nats, redis');
    expect(warning).toContain(DOWN);
  });

  test('everything already up: the run says nothing', async () => {
    const root = await fixtureApp(['live']);
    const all = 'postgres\nredis\nnats\n';
    const { runner } = recording(0, { before: all, after: all });
    const outcome = await reachable().run(ctxOf(root, runner));
    expect(outcome.warnings ?? []).toEqual([]);
  });
});

test('the gate itself wires the live step through the wrap', () => {
  const wired = TEST_STEPS.find((candidate) => candidate.name === 'live');
  expect(wired).toBeDefined();
  expect(wired).not.toBe(bareTestStep('live'));
  expect(wired?.run.toString()).not.toBe(bareTestStep('live').run.toString());
});

describe('one line says which stack the suites got', () => {
  async function run(state: 'up' | 'cold') {
    const root = await fixtureApp(['live']);
    let started = state === 'up';
    const runner: Runner = async (command) => {
      const line = command.join(' ');
      if (line === SERVICES_UP.join(' ')) started = true;
      const listed = line === SERVICES_LIST.join(' ');
      const running = command.includes('--status') && started;
      return {
        command,
        ok: true,
        code: 0,
        stdout:
          listed && started ? psLine('shop-test', 'postgres', root) : running ? 'postgres\n' : '',
        stderr: '',
        durationMs: 0,
      };
    };
    const said: string[] = [];
    const step = withTestServices(
      bareTestStep('live'),
      async () => state === 'up',
      async () => 'ok',
      (line) => said.push(line),
    );
    await step.run(ctxOf(root, runner));
    return said;
  }

  test('a stack already up is reported as reused, with how to stop it', async () => {
    const said = await run('up');
    expect(said).toHaveLength(1);
    expect(said[0]).toStartWith('services: reused shop-test');
    expect(said[0]).toContain('x clean --services');
  });

  test('a cold start is reported as started', async () => {
    const said = await run('cold');
    expect(said).toHaveLength(1);
    expect(said[0]).toStartWith('services: started shop-test');
  });
});

describe('services that could not come up are the reason a floored live step ran nothing', () => {
  /** Docker refuses; the suite's one test skips, as a live test with no database does. */
  const allSkipped: Runner = async (command) => {
    const docker = command[0] === 'docker' && !command.includes('ps');
    const stdout = command[0] === 'bun' ? ' 0 pass\n 1 skip\n 0 fail\n' : '';
    return { command, code: docker ? 1 : 0, ok: !docker, stdout, stderr: '', durationMs: 0 };
  };

  test('the floor holds live: X_TEST_SERVICES_UNAVAILABLE is the finding, first, and red', async () => {
    const root = await fixtureApp(['live']);
    const outcome = await liveStep().run(ctxOf(root, allSkipped));
    expect(outcome.ok).toBe(false);
    expect(outcome.findings[0]?.code).toBe('X_TEST_SERVICES_UNAVAILABLE');
    expect(outcome.findings[0]?.fix).toContain(SERVICES_UP.join(' '));
    expect(outcome.warnings ?? []).toEqual([]);
    // And the gate adds no second, vaguer reason for the same red behind it.
    const [result] = (await runVerify([liveStep()], ctxOf(root, allSkipped))).steps ?? [];
    expect(result?.findings.map((finding) => finding.code)).toEqual([
      'X_TEST_SERVICES_UNAVAILABLE',
    ]);
  });

  test('asked for by --only with no floor: still a warning, as before', async () => {
    const root = await fixtureApp([]);
    const outcome = await liveStep().run(ctxOf(root, allSkipped, ['live']));
    expect(outcome.findings).toEqual([]);
    expect(outcome.warnings?.join('\n')).toContain('X_TEST_SERVICES_UNAVAILABLE');
  });
});
