// The start-first sequence on the injected runner: new containers come up beside the old, are
// waited on, and only then are the old ones stopped. It CONVERGES on the declared replica count —
// a rerun after a half-finished deploy keeps the containers already on the new definition and adds
// none — and a cleanup that fails is reported, never dropped.

import { describe, expect, test } from 'bun:test';
import { COMPOSE_WAIT_TIMEOUT_SECONDS, runStartFirst } from './cmd-deploy-start-first';
import type { ExecResult, Runner } from './exec';

const BASE = ['docker', 'compose', '--env-file', '/app/.env.production', '-f', '/app/c.yml'];
const NEW = 'hash-new';

/** One container as `docker inspect` would describe it. */
interface Box {
  readonly id: string;
  readonly hash: string;
  readonly created: string;
}

/**
 * A fake docker: `ps -q` answers from a queue of listings (ids), `config --hash` with the new
 * definition's hash, `inspect` from the boxes known; `failing` picks an exit code per command.
 */
function docker(
  listings: Box[][],
  failing?: (command: readonly string[]) => number | undefined,
): { runner: Runner; ran: string[][] } {
  const ran: string[][] = [];
  const known = new Map(listings.flat().map((box) => [box.id, box]));
  const runner: Runner = async (command) => {
    ran.push([...command]);
    let stdout = '';
    if (command.includes('ps')) stdout = (listings.shift() ?? []).map((box) => box.id).join('\n');
    else if (command.includes('--hash')) stdout = `${command.at(-1)} ${NEW}\n`;
    else if (command[1] === 'inspect') {
      stdout = command
        .filter((word) => known.has(word))
        .map((id) => {
          const box = known.get(id);
          return `${id} ${box?.created} ${box?.hash}`;
        })
        .join('\n');
    }
    const code = failing?.(command) ?? 0;
    const result: ExecResult = { command, code, ok: code === 0, stdout, stderr: '', durationMs: 1 };
    return result;
  };
  return { runner, ran };
}

const stale = (id: string, created = '2026-10-01T00:00:00Z'): Box => ({ id, hash: 'old', created });
const fresh = (id: string, created = '2026-10-05T00:00:00Z'): Box => ({ id, hash: NEW, created });
const wait = ['--wait', '--wait-timeout', String(COMPOSE_WAIT_TIMEOUT_SECONDS)];
const INSPECT = '{{.Id}} {{.Created}} {{index .Config.Labels "com.docker.compose.config-hash"}}';
const run = (role: string, replicas: number, runner: Runner) =>
  runStartFirst({ role, base: BASE, replicas, runner, options: { cwd: '/app', env: {} } });

/** The commands after the three reads every non-fresh run starts with (ps, config, inspect). */
const after = (ran: string[][]): string[][] => ran.slice(3);

describe('unit · the start-first sequence', () => {
  test('scale up beside the old containers, wait for health, then stop and remove the old ones', async () => {
    const { runner, ran } = docker([[stale('o1'), stale('o2')]]);
    expect(await run('worker', 2, runner)).toEqual({ ok: true });
    expect(ran.slice(0, 3)).toEqual([
      [...BASE, 'ps', '-q', 'worker'],
      [...BASE, 'config', '--hash', 'worker'],
      ['docker', 'inspect', '--format', INSPECT, 'o1', 'o2'],
    ]);
    expect(after(ran)).toEqual([
      [...BASE, 'up', '-d', '--no-deps', '--no-recreate', ...wait, '--scale', 'worker=4', 'worker'],
      ['docker', 'stop', 'o1', 'o2'],
      ['docker', 'rm', 'o1', 'o2'],
    ]);
  });

  test('a rerun after a failed stop adds nothing: the new containers already there are kept', async () => {
    // The previous run brought n1 up and then failed to stop o1. Running again must not scale to
    // running + replicas (= 3) — every failed rerun would add a replica — but finish the job.
    const { runner, ran } = docker([[stale('o1'), fresh('n1')]]);
    expect(await run('web', 1, runner)).toEqual({ ok: true });
    expect(after(ran)).toEqual([
      [...BASE, 'up', '-d', '--no-deps', '--no-recreate', ...wait, '--scale', 'web=2', 'web'],
      ['docker', 'stop', 'o1'],
      ['docker', 'rm', 'o1'],
    ]);
  });

  test('more containers on the new definition than declared: the newest are kept, the rest stop', async () => {
    const { runner, ran } = docker([
      [fresh('n1', '2026-10-05T01:00:00Z'), fresh('n2', '2026-10-05T02:00:00Z'), stale('o1')],
    ]);
    expect(await run('worker', 1, runner)).toEqual({ ok: true });
    expect(after(ran)).toEqual([
      [...BASE, 'up', '-d', '--no-deps', '--no-recreate', ...wait, '--scale', 'worker=3', 'worker'],
      ['docker', 'stop', 'o1', 'n1'],
      ['docker', 'rm', 'o1', 'n1'],
    ]);
  });

  test('the old containers are never stopped before the new ones answered healthy', async () => {
    const { runner, ran } = docker([[stale('o1')], [stale('o1'), fresh('n1')]], (command) =>
      command.includes('up') ? 1 : undefined,
    );
    const outcome = await run('web', 1, runner);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.command).toContain('--no-recreate');
    // The unhealthy replica is taken away; the one that was serving is untouched.
    expect(after(ran).slice(1)).toEqual([
      [...BASE, 'ps', '-q', 'web'],
      ['docker', 'stop', 'n1'],
      ['docker', 'rm', 'n1'],
    ]);
    expect(after(ran).flat()).not.toContain('o1');
  });

  test('a cleanup that fails is reported with its argv, beside the up that failed', async () => {
    const { runner } = docker([[stale('o1')], [stale('o1'), fresh('n1')]], (command) =>
      command.includes('up') ? 1 : command[1] === 'stop' ? 3 : undefined,
    );
    const outcome = await run('web', 1, runner);
    expect(outcome).toMatchObject({
      ok: false,
      code: 1,
      cleanup: { code: 3, command: ['docker', 'stop', 'n1'] },
    });
  });

  test('a first deploy has nothing to replace: one up, waited on, and no stop', async () => {
    const { runner, ran } = docker([[]]);
    expect(await run('scheduler', 1, runner)).toEqual({ ok: true });
    expect(ran).toEqual([
      [...BASE, 'ps', '-q', 'scheduler'],
      [...BASE, 'up', '-d', '--no-deps', ...wait, 'scheduler'],
    ]);
  });

  test('a stop that fails is the failure reported, with its argv', async () => {
    const { runner } = docker([[stale('o1')]], (command) =>
      command[1] === 'stop' ? 2 : undefined,
    );
    expect(await run('worker', 1, runner)).toEqual({
      ok: false,
      code: 2,
      command: ['docker', 'stop', 'o1'],
    });
  });
});
