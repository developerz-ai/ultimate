// `x deploy` rolls each serving role without a gap where the platform allows it: a compose role
// that can run two containers starts the new one first, and a helm release sizes every role's
// grace period from the drain budget `app.config.ts` declares — not from the chart's defaults.

import { describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, and the fixtures are written synchronously.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { deployCommand } from './cmd-deploy';
import type { CommandContext } from './command';
import type { ExecResult } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const COMPOSE = `
services:
  migrate: { image: 'app' }
  web: { image: 'app', ports: ['3000:3000'] }
  sync: { image: 'app', deploy: { replicas: 0 } }
  worker: { image: 'app', deploy: { replicas: 2 } }
  scheduler: { image: 'app' }
  backfill: { image: 'app' }
`;

function appRoot(config: string, compose?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'x-deploy-rollout-'));
  writeFileSync(join(dir, 'app.config.ts'), `export const config = ${config};\n`);
  if (compose !== undefined) {
    mkdirSync(join(dir, 'docker'), { recursive: true });
    writeFileSync(join(dir, 'docker', 'docker-compose.prod.yml'), compose);
  }
  return dir;
}

/** Records every spawn; `ps -q worker` answers with the two containers serving now. */
function recording(): {
  ran: string[][];
  context: (argv: string[], cwd: string) => CommandContext;
} {
  const ran: string[][] = [];
  const runner: CommandContext['runner'] = async (command) => {
    ran.push([...command]);
    const listing = command.includes('ps') && command.at(-1) === 'worker' ? 'w1\nw2\n' : '';
    const result: ExecResult = {
      command,
      code: 0,
      ok: true,
      stdout: listing,
      stderr: '',
      durationMs: 1,
    };
    return result;
  };
  return {
    ran,
    context: (argv, cwd) => ({
      args: parseArgs(argv, SPECS),
      cwd,
      runner,
      env: {},
      bunVersion: REQUIRED_BUN,
    }),
  };
}

describe('unit · a compose deploy starts the new container first where it can', () => {
  test('worker is scaled up beside its old containers, which are stopped only after', async () => {
    const root = appRoot("{ name: 'demo-app' }", COMPOSE);
    const { ran, context } = recording();
    const result = await deployCommand.run(context(['deploy', '--image', 'repo/app:2'], root));
    expect(result.ok).toBe(true);
    const tail = (command: string[]): string => command.slice(6).join(' ');
    expect(
      ran.map((command) =>
        command[0] === 'docker' && command[1] === 'compose' ? tail(command) : command.join(' '),
      ),
    ).toEqual([
      'run --rm migrate',
      // web publishes 3000: compose's own recreate, unchanged.
      'up -d web',
      // sync runs no container now: one up, waited on.
      'ps -q sync',
      'up -d --no-deps --wait --wait-timeout 300 sync',
      'ps -q worker',
      'up -d --no-deps --no-recreate --wait --wait-timeout 300 --scale worker=4 worker',
      'docker stop w1 w2',
      'docker rm w1 w2',
      'ps -q scheduler',
      'up -d --no-deps --wait --wait-timeout 300 scheduler',
      'run --rm backfill',
    ]);
  });

  test('the plan names each serving role’s strategy, and why web stays stop-first', async () => {
    const root = appRoot("{ name: 'demo-app' }", COMPOSE);
    const { context } = recording();
    const result = await deployCommand.run(
      context(['deploy', '--image', 'repo/app:2', '--dry-run'], root),
    );
    const steps = (result.data as { steps: { role: string; strategy?: string; why?: string }[] })
      .steps;
    const byRole = new Map(steps.map((step) => [step.role, step]));
    expect(byRole.get('worker')?.strategy).toBe('start-first');
    expect(byRole.get('web')?.strategy).toBe('stop-first');
    expect(byRole.get('web')?.why).toContain('3000');
    expect(byRole.get('migrate')?.strategy).toBeUndefined();
    expect((result.lines ?? []).join('\n')).toContain('--scale worker=4 worker');
  });
});

describe('unit · a helm deploy sizes the grace period from app.config.ts', () => {
  test('the declared drain budget reaches the chart, in seconds', async () => {
    const root = appRoot(
      "{ name: 'demo-app', drain: { deadlineMs: 600000, readinessGraceMs: 7500 } }",
    );
    const { ran, context } = recording();
    const result = await deployCommand.run(
      context(['deploy', '--image', 'repo/app:2', '--method', 'helm'], root),
    );
    expect(result.ok).toBe(true);
    const argv = ran[0] ?? [];
    expect(argv.slice(-4)).toEqual([
      '--set',
      'drain.deadlineSeconds=600',
      '--set',
      'drain.readinessGraceSeconds=8',
    ]);
  });

  test('a grace below the framework default is budgeted at the default — over, never under', async () => {
    const root = appRoot("{ name: 'demo-app', drain: { readinessGraceMs: 0 } }");
    const { ran, context } = recording();
    await deployCommand.run(context(['deploy', '--image', 'repo/app:2', '--method', 'helm'], root));
    expect(ran[0]?.slice(-4)).toEqual([
      '--set',
      'drain.deadlineSeconds=25',
      '--set',
      'drain.readinessGraceSeconds=5',
    ]);
  });
});
