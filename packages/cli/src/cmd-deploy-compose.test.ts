// A compose deploy starts the new container before it stops the old one, wherever compose can run
// two at once: scale up with `--no-recreate`, wait for the healthcheck, then stop and remove the
// containers that were serving before. Where it cannot — a published host port, a container_name —
// the plan says so and keeps compose's stop-first recreate. Sequences asserted on the injected runner.

import { describe, expect, test } from 'bun:test';
import {
  COMPOSE_WAIT_TIMEOUT_SECONDS,
  composeStrategies,
  runStartFirst,
} from './cmd-deploy-compose';
import type { ExecResult, Runner } from './exec';

const BASE = ['docker', 'compose', '--env-file', '/app/.env.production', '-f', '/app/c.yml'];

const COMPOSE = `
x-common: &common
  image: \${IMAGE:-app:latest}
  stop_grace_period: 40s
services:
  migrate: { <<: *common }
  web:
    <<: *common
    ports: ['3000:3000']
    deploy: { replicas: 1 }
  sync:
    <<: *common
    ports: ['127.0.0.1:3001:3001']
  worker:
    <<: *common
    deploy: { replicas: 2 }
  scheduler:
    <<: *common
    ports: ['9090']
`;

describe('unit · which roles can start first', () => {
  test('a role publishing a fixed host port stays stop-first, and the plan names why', () => {
    const strategies = composeStrategies(COMPOSE);
    expect(strategies.get('web')).toMatchObject({ kind: 'stop-first' });
    const web = strategies.get('web');
    expect(web?.kind === 'stop-first' ? web.why : '').toContain('3000');
    // An address-bound publish is still one binder for that host port.
    expect(strategies.get('sync')).toMatchObject({ kind: 'stop-first' });
  });

  test('a role with no fixed host port starts first, at its declared replica count', () => {
    const strategies = composeStrategies(COMPOSE);
    expect(strategies.get('worker')).toEqual({ kind: 'start-first', replicas: 2 });
    // A container-only port lets Docker pick the host side, so two replicas never collide.
    expect(strategies.get('scheduler')).toEqual({ kind: 'start-first', replicas: 1 });
  });

  test('container_name, host networking and long-syntax publishes are stop-first too', () => {
    const strategies = composeStrategies(`
services:
  web: { image: a, container_name: app-web }
  sync: { image: a, network_mode: host }
  worker: { image: a, ports: [{ target: 3000, published: '8080' }] }
  scheduler: { image: a, ports: [{ target: 9090 }, '127.0.0.1::9091'] }
`);
    expect(strategies.get('web')?.kind).toBe('stop-first');
    expect(strategies.get('sync')?.kind).toBe('stop-first');
    expect(strategies.get('worker')?.kind).toBe('stop-first');
    expect(strategies.get('scheduler')).toEqual({ kind: 'start-first', replicas: 1 });
  });

  test('an unreadable compose file decides nothing: every role keeps stop-first', () => {
    for (const text of [undefined, 'services: [', 'just a string']) {
      const strategies = composeStrategies(text);
      for (const role of ['web', 'sync', 'worker', 'scheduler']) {
        expect(strategies.get(role)?.kind ?? 'stop-first').toBe('stop-first');
      }
    }
  });
});

/** Answers `ps -q` from a queue of listings; everything else with the code the test chose. */
function scripted(
  listings: string[][],
  failing?: (command: readonly string[]) => number | undefined,
): { runner: Runner; ran: string[][] } {
  const ran: string[][] = [];
  const runner: Runner = async (command) => {
    ran.push([...command]);
    const isPs = command.includes('ps');
    const code = isPs ? 0 : (failing?.(command) ?? 0);
    const result: ExecResult = {
      command,
      code,
      ok: code === 0,
      stdout: isPs ? `${(listings.shift() ?? []).join('\n')}\n` : '',
      stderr: '',
      durationMs: 1,
    };
    return result;
  };
  return { runner, ran };
}

const wait = ['--wait', '--wait-timeout', String(COMPOSE_WAIT_TIMEOUT_SECONDS)];

describe('unit · the start-first sequence', () => {
  test('scale up beside the old containers, wait for health, then stop and remove the old ones', async () => {
    const { runner, ran } = scripted([['old1', 'old2']]);
    const outcome = await runStartFirst({
      role: 'worker',
      base: BASE,
      replicas: 2,
      runner,
      options: { cwd: '/app', env: { IMAGE: 'repo/app:2' } },
    });
    expect(outcome).toEqual({ ok: true });
    expect(ran).toEqual([
      [...BASE, 'ps', '-q', 'worker'],
      [...BASE, 'up', '-d', '--no-deps', '--no-recreate', ...wait, '--scale', 'worker=4', 'worker'],
      ['docker', 'stop', 'old1', 'old2'],
      ['docker', 'rm', 'old1', 'old2'],
    ]);
  });

  test('the old containers are never stopped before the new ones answered healthy', async () => {
    const { runner, ran } = scripted([['old1'], ['old1', 'new1']], (command) =>
      command.includes('up') ? 1 : undefined,
    );
    const outcome = await runStartFirst({
      role: 'web',
      base: BASE,
      replicas: 1,
      runner,
      options: { cwd: '/app', env: {} },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.command).toContain('--no-recreate');
    // The unhealthy replica is taken away; the one that was serving is untouched.
    expect(ran.slice(2)).toEqual([
      [...BASE, 'ps', '-q', 'web'],
      ['docker', 'stop', 'new1'],
      ['docker', 'rm', 'new1'],
    ]);
    expect(ran.flat()).not.toContain('old1');
  });

  test('a first deploy has nothing to replace: one up, waited on, and no stop', async () => {
    const { runner, ran } = scripted([[]]);
    const outcome = await runStartFirst({
      role: 'scheduler',
      base: BASE,
      replicas: 1,
      runner,
      options: { cwd: '/app', env: {} },
    });
    expect(outcome).toEqual({ ok: true });
    expect(ran).toEqual([
      [...BASE, 'ps', '-q', 'scheduler'],
      [...BASE, 'up', '-d', '--no-deps', ...wait, 'scheduler'],
    ]);
  });

  test('a stop that fails is the failure reported, with its argv', async () => {
    const { runner } = scripted([['old1']], (command) => (command[1] === 'stop' ? 2 : undefined));
    const outcome = await runStartFirst({
      role: 'worker',
      base: BASE,
      replicas: 1,
      runner,
      options: { cwd: '/app', env: {} },
    });
    expect(outcome).toEqual({ ok: false, code: 2, command: ['docker', 'stop', 'old1'] });
  });
});
