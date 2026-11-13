// `x exercise` end to end on a fixture app: the real pass, on a real scratch database. A handler
// that works is `reached`, one that throws is `unreached` and red with its override as the fix,
// `<name>` runs one primitive, and `--json`'s data is byte for byte what `.x/exercise.json` holds.
// Registries are process-global, so every test resets them.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { action, resetActions, t } from '@ultimat3/action';
import { registerActions } from '@ultimat3/action/loader';
import { registeredJobs, resetJobs, restoreJobs } from '@ultimat3/jobs';
import {
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
} from '@ultimat3/policy';
import { from, query, resetQueries } from '@ultimat3/query';
import { registerQuery } from '@ultimat3/query/loader';
import { disk } from '@ultimat3/storage';
import { isolateEntityRegistry } from '@ultimat3/testing/registry-isolation';
import { REQUIRED_BUN } from './app-root';
import { exerciseCommand, exerciseRoles } from './cmd-exercise';
import type { CommandContext } from './command';
import { EXERCISE_REPORT_FILE } from './exercise-findings';
import type { FlagValue } from './parse';
import { processRoot } from './process-root-fixture';

const ROOT = processRoot(join(import.meta.dir, '..', '.exercise-fixture'));

const contextFor = (positionals: readonly string[] = []): CommandContext => ({
  args: {
    command: 'exercise',
    subcommand: undefined,
    positionals,
    flags: new Map<string, FlagValue>([['seed', '7']]),
    json: true,
    help: false,
    passthrough: [],
  },
  cwd: ROOT,
  runner: async () => ({
    command: ['true'],
    code: 0,
    ok: true,
    stdout: '',
    stderr: '',
    durationMs: 0,
  }),
  env: { ULTIMATE_STATE_DIR: join(ROOT, '.x') },
  bunVersion: REQUIRED_BUN,
});

let broken = false;

const register = (): void => {
  definePermissions(['cx:write'] as const);
  defineRoles({ writer: { grants: ['cx:write'] } });
  registerActions({
    cxWorks: action({
      input: t.object({ title: t.string.min(1).max(20) }),
      output: t.object({ ok: t.boolean }),
      policy: can('cx:write'),
      handle: async () => ({ ok: true }),
    }),
    cxToggle: action({
      input: t.object({}),
      output: t.object({ ok: t.boolean }),
      policy: can('cx:write'),
      handle: () =>
        broken ? Promise.reject(new TypeError('mutated')) : Promise.resolve({ ok: true }),
    }),
  });
};

beforeAll(async () => {
  await Bun.write(join(ROOT, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
});
afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});
const clearDeclarations = (): void => {
  resetActions();
  resetQueries();
  clearRoles();
  clearPermissions();
};
// The pass seeds EVERY registered entity and runs EVERY registered job, and a neighbouring file in
// this process may have declared either at module scope (`exercise.test.ts`' jobs, over a table
// this fixture's migrations never make): both emptied here, every handle put back after.
let restoreEntities: () => void = () => undefined;
let inheritedJobs: ReturnType<typeof registeredJobs> = [];
beforeEach(() => {
  broken = false;
  restoreEntities = isolateEntityRegistry();
  inheritedJobs = registeredJobs();
  resetJobs();
  clearDeclarations();
  register();
});
afterEach(() => {
  clearDeclarations();
  restoreJobs(inheritedJobs);
  restoreEntities();
});

const outcomes = (data: unknown): Record<string, string> =>
  Object.fromEntries(
    ((data as { records: { name: string; outcome: string }[] }).records ?? []).map((one) => [
      one.name,
      one.outcome,
    ]),
  );

describe('unit · x exercise', () => {
  test('every primitive reached is green, and --json is what .x/exercise.json holds', async () => {
    const result = await exerciseCommand.run(contextFor());
    expect(outcomes(result.data)).toEqual({ cxToggle: 'reached', cxWorks: 'reached' });
    expect(result.ok).toBe(true);
    const written: unknown = await Bun.file(join(ROOT, EXERCISE_REPORT_FILE)).json();
    expect(written).toEqual(JSON.parse(JSON.stringify(result.data)));
    expect((written as { seed: number }).seed).toBe(7);
  }, 60_000);

  test('a mutated handler turns the run red, its fix the override to paste', async () => {
    broken = true;
    const result = await exerciseCommand.run(contextFor());
    expect(outcomes(result.data)['cxToggle']).toBe('unreached');
    expect(result.ok).toBe(false);
    const [finding] = result.findings ?? [];
    expect(finding?.code).toBe('X_CONTRACT_EXERCISE_UNREACHED');
    expect(finding?.fix).toContain('cxToggle:');
    expect(finding?.fix).toContain('x exercise cxToggle --json');
    // The fixture has no apps/web/exercise.ts: the fix is the file to create, entry inside.
    expect(finding?.fix).toStartWith("import { defineExercise } from '@ultimat3/testing';");
  }, 60_000);

  // A boot installs a storage disk; the pass stands one in, so a handler writing to it is reached
  // with nothing declared — it was `storage() was called before defineStorage()`, and an `{ off }`.
  test('a handler that writes to the storage disk is reached with no entry', async () => {
    registerActions({
      cxStore: action({
        input: t.object({}),
        output: t.object({ ok: t.boolean }),
        policy: can('cx:write'),
        handle: async () => {
          await disk().put(`cx/${crypto.randomUUID()}`, new TextEncoder().encode('held'));
          return { ok: true };
        },
      }),
    });
    const result = await exerciseCommand.run(contextFor(['cxStore']));
    expect(outcomes(result.data)).toEqual({ cxStore: 'reached' });
  }, 60_000);

  // A read returning none of the tenant's rows leaves its tenant proof `unproven`: the floor's case.
  const unprovenRead = (): void => {
    registerQuery(
      'cxFeed',
      query({
        input: t.object({}),
        policy: can('cx:write'),
        sql: () => from<{ id: string }>('cx_rows', [{ id: 'a' }]),
      }),
    );
  };

  test('an unproven primitive with no exercise floor is a warning, and the run stays green', async () => {
    unprovenRead();
    const result = await exerciseCommand.run(contextFor());
    expect(result.ok).toBe(true);
    expect(result.findings ?? []).toEqual([]);
    const warnings = (result.data as { warnings?: readonly string[] }).warnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"unprovenMax": 0.3334');
    expect(result.lines?.some((line) => line.includes('! exercise left 1 of 3'))).toBe(true);
  }, 60_000);

  test('the same pass above a declared unprovenMax is red, naming the primitive', async () => {
    unprovenRead();
    await Bun.write(join(ROOT, 'x.verify.json'), JSON.stringify({ exercise: { unprovenMax: 0 } }));
    try {
      const result = await exerciseCommand.run(contextFor());
      expect(result.ok).toBe(false);
      const codes = (result.findings ?? []).map((finding) => finding.code);
      expect(codes).toEqual(['X_EXERCISE_UNPROVEN_ABOVE_FLOOR']);
      expect(result.findings?.[0]?.cause).toContain('query cxFeed');
    } finally {
      await rm(join(ROOT, 'x.verify.json'), { force: true });
    }
  }, 60_000);

  test('<name> runs that one primitive and nothing else', async () => {
    const result = await exerciseCommand.run(contextFor(['cxWorks']));
    expect(Object.keys(outcomes(result.data))).toEqual(['cxWorks']);
  }, 60_000);

  test('the actors are x policy explain’s, each moved into the tenant asked for', () => {
    const actors = exerciseRoles('tenant-1');
    expect(actors.map((one) => one.name)).toEqual(['anonymous', 'writer']);
    expect(actors[1]?.actor?.orgId).toBe('tenant-1');
  });
});
