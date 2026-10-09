// `x deploy` rolls each serving role without a gap where the platform allows it: a compose role
// that can run two containers starts the new one first, and a helm release sizes every role's
// grace period from the drain budget `app.config.ts` declares — not from the chart's defaults.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, and the fixtures are written synchronously.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** Every temp dir this file makes, removed after it: a fixture that outlives its run is a leftover (#738). */
const madeDirs: string[] = [];
afterAll(() => {
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const trackedDirSync = (prefix: string): string => {
  const dir = mkdtempSync(prefix);
  madeDirs.push(dir);
  return dir;
};

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
  const dir = trackedDirSync(join(tmpdir(), 'x-deploy-rollout-'));
  writeFileSync(join(dir, 'app.config.ts'), `export const config = ${config};\n`);
  if (compose !== undefined) {
    mkdirSync(join(dir, 'docker'), { recursive: true });
    writeFileSync(join(dir, 'docker', 'docker-compose.prod.yml'), compose);
  }
  return dir;
}

/** Records every spawn; `ps -q worker` answers with the two containers serving now. */
function recording(failing?: (command: readonly string[]) => number | undefined): {
  ran: string[][];
  context: (argv: string[], cwd: string) => CommandContext;
} {
  const ran: string[][] = [];
  let workerListings = 0;
  const runner: CommandContext['runner'] = async (command) => {
    ran.push([...command]);
    // The second listing of a failed roll sees the replica the failed `up` created.
    const isWorkerPs = command.includes('ps') && command.at(-1) === 'worker';
    if (isWorkerPs) workerListings += 1;
    const listing = isWorkerPs ? (workerListings === 1 ? 'w1\nw2\n' : 'w1\nw2\nn1\n') : '';
    const code = failing?.(command) ?? 0;
    const result: ExecResult = {
      command,
      code,
      ok: code === 0,
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
      'config --hash worker',
      'docker inspect --format {{.Id}} {{.Created}} {{index .Config.Labels "com.docker.compose.config-hash"}} w1 w2',
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

describe('unit · a failed start-first roll names what it could not clean up', () => {
  test('a stop of the unhealthy replica that fails is in the X_DEPLOY_FAILED finding, with its ids', async () => {
    const root = appRoot("{ name: 'demo-app' }", COMPOSE);
    const { context } = recording((command) =>
      command.includes('--no-recreate') ? 1 : command[1] === 'stop' ? 5 : undefined,
    );
    const result = await deployCommand.run(context(['deploy', '--image', 'repo/app:2'], root));
    expect(result.ok).toBe(false);
    const finding = result.findings?.[0];
    expect(finding?.code).toBe('X_DEPLOY_FAILED');
    expect(finding?.cause).toContain('role "worker" step exited 1');
    expect(finding?.cause).toContain('docker stop n1');
    expect(finding?.cause).toContain('exited 5');
    // The fix stays the command that failed, to rerun.
    expect(finding?.fix).toContain('--scale worker=4 worker');
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
