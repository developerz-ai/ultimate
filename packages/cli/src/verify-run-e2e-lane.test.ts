// The second serial lane: in a package monorepo the `e2e` suite runs BESIDE `live` instead of after
// it, with every service URL taken out of its children's environment — so the two serial suites
// share a clock and nothing else. An app keeps them in single file.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive; an app root needs a real `app.config.ts` on disk.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { ExecOptions, ExecResult } from './exec';
import { runVerify } from './verify-run';
import type { VerifyContext, VerifyStep } from './verify-step';
import { VERIFY_STEP_NAMES } from './verify-step';

const ENV = {
  TEST_DATABASE_URL: 'postgres://127.0.0.1:5432/postgres',
  TEST_REPLICATION_URL: 'postgres://127.0.0.1:5433/postgres',
  DATABASE_URL: 'postgres://127.0.0.1:5432/app',
  PATH: '/usr/bin',
};

const yieldTurn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

const childEnvs = new Map<string, Readonly<Record<string, string | undefined>> | undefined>();

const runner: VerifyContext['runner'] = async (
  command: readonly string[],
  _options?: ExecOptions,
): Promise<ExecResult> => ({ command, code: 0, ok: true, stdout: '', stderr: '', durationMs: 0 });

/** Every step logs its edges around a macrotask and spawns one child, whose env is recorded. */
function steps(log: string[]): readonly VerifyStep[] {
  return VERIFY_STEP_NAMES.map((name) => ({
    name,
    summary: name,
    run: async (ctx) => {
      log.push(`start ${name}`);
      await ctx.runner(['bun', 'test'], {
        cwd: ctx.root,
        env: { OWN: '1' },
        onSpawn: () => undefined,
      });
      // Turns of the event loop, never the wall clock: `live` simply yields longest.
      for (let turn = 0; turn < (name === 'live' ? 50 : 5); turn += 1) await yieldTurn();
      log.push(`end ${name}`);
      return { ok: true, findings: [] };
    },
  }));
}

const recording: VerifyContext['runner'] = async (command, options) => {
  const tag = options?.env?.['ULTIMATE_VERIFY_STEP'];
  // A nested gate APPENDS its tag to the inherited one (`verify-deadline.ts`), and this suite runs
  // inside the outer gate's `unit` step: the step that spawned this child is the last tag.
  const own = typeof tag === 'string' ? tag.split(' ').at(-1) : undefined;
  if (own !== undefined) childEnvs.set(own.split('@')[0] ?? '', options?.env);
  return runner(command, options);
};

let app = '';
beforeAll(async () => {
  app = await mkdtemp(join(tmpdir(), 'x-verify-e2e-lane-'));
  await Bun.write(join(app, 'app.config.ts'), 'export const config = {};\n');
});
afterAll(async () => {
  await rm(app, { recursive: true, force: true });
});

describe('unit · e2e runs beside live in a package monorepo', () => {
  test('e2e starts before live ends, and the table still reads in declared order', async () => {
    const log: string[] = [];
    const result = await runVerify(steps(log), {
      root: '/nonexistent',
      runner: recording,
      env: ENV,
    });
    // Started with the static group as `live` begins — after the parallel suites, never beside them.
    expect(log).toContain('start e2e');
    expect(log).toContain('end contract');
    expect(log).toContain('end live');
    expect(log.indexOf('start e2e')).toBeGreaterThan(log.indexOf('end contract'));
    expect(log.indexOf('start e2e')).toBeLessThan(log.indexOf('end live'));
    expect(result.steps?.map((step) => step.name)).toEqual([...VERIFY_STEP_NAMES]);
  });

  test("e2e's children see no service URL; live's keep theirs", async () => {
    childEnvs.clear();
    await runVerify(steps([]), { root: '/nonexistent', runner: recording, env: ENV });
    const e2e = childEnvs.get('e2e') ?? {};
    for (const key of ['TEST_DATABASE_URL', 'TEST_REPLICATION_URL', 'DATABASE_URL']) {
      expect(Object.hasOwn(e2e, key)).toBe(true);
      expect(e2e[key]).toBeUndefined();
    }
    expect(e2e['OWN']).toBe('1');
    expect(Object.hasOwn(childEnvs.get('live') ?? {}, 'TEST_DATABASE_URL')).toBe(false);
  });

  test('in an app, e2e waits for live: its app boots against the services live uses', async () => {
    const log: string[] = [];
    await runVerify(steps(log), { root: app, runner: recording, env: ENV });
    expect(log.indexOf('start e2e')).toBeGreaterThan(log.indexOf('end live'));
    expect(log.indexOf('end live')).toBeGreaterThan(-1);
  });

  test('without live in the list, e2e runs in its own place with its environment intact', async () => {
    childEnvs.clear();
    const log: string[] = [];
    await runVerify(steps(log), {
      root: '/nonexistent',
      runner: recording,
      env: ENV,
      only: ['typecheck', 'e2e'],
    });
    expect(log).toEqual(['start typecheck', 'end typecheck', 'start e2e', 'end e2e']);
    expect(Object.hasOwn(childEnvs.get('e2e') ?? {}, 'TEST_DATABASE_URL')).toBe(false);
  });
});
