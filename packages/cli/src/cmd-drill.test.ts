// `x drill`'s refusals and its listing, on a fixture app: every refusal is decided before any
// process or database exists — an unknown drill, an unset service, a service the app does not use,
// a budget that is not a number — and a refusal is never a green run of nothing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { NotImplementedError } from '@ultimat3/core';
import { REQUIRED_BUN } from './app-root';
import type { DrillFleetRun } from './cmd-drill';
import { drillCommand, thrownRun, withDrillFleet } from './cmd-drill';
import type { CommandContext } from './command';
import type { FlagValue } from './parse';
import { processRoot } from './process-root-fixture';

const ROOT = processRoot(join(import.meta.dir, '..', '.drill-fixture'));

const contextFor = (
  positionals: readonly string[],
  flags: readonly [string, FlagValue][] = [],
  env: Readonly<Record<string, string>> = {},
): CommandContext => ({
  args: {
    command: 'drill',
    subcommand: undefined,
    positionals,
    flags: new Map<string, FlagValue>(flags),
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
  env,
  bunVersion: REQUIRED_BUN,
});

beforeAll(async () => {
  await Bun.write(join(ROOT, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

const refusal = async (ctx: CommandContext): Promise<unknown> =>
  drillCommand.run(ctx).then(
    () => expect.unreachable('x drill ran where it had to refuse'),
    (error: unknown) => error,
  );

describe('x drill', () => {
  test('--list names all nine drills, roll-before-migrate among them, and runs nothing', async () => {
    const result = await drillCommand.run(contextFor([], [['list', true]]));
    expect(result.ok).toBe(true);
    const data = result.data as { drills: { name: string; holds: string[] }[] };
    expect(data.drills.map((drill) => drill.name)).toHaveLength(9);
    expect(data.drills.find((drill) => drill.name === 'roll-before-migrate')?.holds).toEqual([
      'roles-wait',
      'serves-after-migrate',
      'one-wait-line',
    ]);
    expect(data.drills.find((drill) => drill.name === 'pg-blackhole')?.holds).toContain(
      'requests-coded',
    );
  });

  test('an unknown drill is refused with the list', async () => {
    const error = await refusal(contextFor(['pg-nope']));
    expect(error).toBeUltimateError('X_CLI_UNKNOWN_COMMAND');
    expect(String(Reflect.get(error as object, 'cause'))).toContain('pg-blackhole');
  });

  test('no TEST_DATABASE_URL is X_DRILL_SERVICE_MISSING, never a skip', async () => {
    expect(await refusal(contextFor(['pg-blackhole']))).toBeUltimateError(
      'X_DRILL_SERVICE_MISSING',
    );
    expect(await refusal(contextFor([]))).toBeUltimateError('X_DRILL_SERVICE_MISSING');
    const rolled = await refusal(contextFor(['roll-before-migrate']));
    expect(rolled).toBeUltimateError('X_DRILL_SERVICE_MISSING');
    expect(String(Reflect.get(rolled as object, 'cause'))).toContain('TEST_DATABASE_URL');
  });

  test('an unknown drill is refused with roll-before-migrate in the list', async () => {
    const error = await refusal(contextFor(['roll-nope']));
    expect(String(Reflect.get(error as object, 'cause'))).toContain('roll-before-migrate');
  });

  test('redis-down on an app whose cache names no redis tier is refused', async () => {
    const env = { TEST_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/postgres' };
    const error = await refusal(contextFor(['redis-down'], [], env));
    expect(error).toBeUltimateError('X_DRILL_SERVICE_MISSING');
    expect(String(Reflect.get(error as object, 'cause'))).toContain('does not use');
  });

  test('--budget-ms must be a whole number of milliseconds', async () => {
    const error = await refusal(contextFor(['pg-slow'], [['budget-ms', '5s']]));
    expect(error).toBeUltimateError('X_CLI_BAD_FLAG');
  });
});

// H9: the fleet is a set of spawned role processes. Whatever throws between their start and the
// end of the drill — the evidence connection's constructor included — must not leak them.
describe('x drill · the fleet is always stopped', () => {
  const fleet = () => {
    const stopped: string[] = [];
    return {
      stopped,
      fleet: {
        databaseUrl: 'postgres://u@[bad',
        stop: async () => {
          stopped.push('stop');
        },
      },
    };
  };
  /** What the body (or the connection) threw; a run that returned a value is the test's failure. */
  const thrownOf = (run: DrillFleetRun<unknown>): unknown =>
    'thrown' in run ? run.thrown : expect.unreachable('the run returned a value');
  const boom = (what: string) =>
    new NotImplementedError({
      cause: `${what} in this test is not implemented`,
      fix: 'x drill --list --json',
    });

  test('a throwing evidence connection still stops the fleet, and the throw is kept', async () => {
    const { stopped, fleet: started } = fleet();
    const run = withDrillFleet(
      started,
      () => {
        throw boom('the connection');
      },
      async () => 'ran',
    );
    expect(thrownOf(await run)).toBeUltimateError('X_NOT_IMPLEMENTED');
    expect(stopped).toEqual(['stop']);
  });

  test('a close that throws still stops the fleet', async () => {
    const { stopped, fleet: started } = fleet();
    const sql = {
      rows: async () => [],
      close: async () => {
        throw boom('close');
      },
    };
    const run = withDrillFleet(
      started,
      () => sql,
      async () => 'ran',
    );
    expect(thrownOf(await run)).toBeUltimateError('X_NOT_IMPLEMENTED');
    expect(stopped).toEqual(['stop']);
  });

  // A drop refused at teardown (a slot still held) used to REPLACE the drill's report: the verdict
  // that held was lost, and the run read as the teardown's error alone.
  test('a stop that throws keeps the body report and adds the teardown as its own finding', async () => {
    const sql = { rows: async () => [], close: async () => undefined };
    const run = await withDrillFleet(
      {
        databaseUrl: 'postgres://u@127.0.0.1/x_drill_0123456789abcdef',
        stop: async () => {
          throw boom('the scratch database drop');
        },
      },
      () => sql,
      async () => 'held',
    );
    expect('value' in run ? run.value : undefined).toBe('held');
    expect(run.teardown).toEqual([
      expect.objectContaining({
        code: 'X_NOT_IMPLEMENTED',
        cause: expect.stringContaining('the scratch database drop'),
      }),
    ]);
  });

  // The scratch database the teardown could not drop is the leak X_DRILL_TEARDOWN_FAILED exists to
  // name: a body that threw first must not take that finding down with it.
  test('a body that threw keeps its own throw AND the teardown finding when the stop throws too', async () => {
    const run = withDrillFleet(
      {
        databaseUrl: 'postgres://u@127.0.0.1/x',
        stop: async () => {
          throw boom('the drop');
        },
      },
      () => ({ rows: async () => [], close: async () => undefined }),
      async () => {
        throw boom('the body');
      },
    );
    const settled = await run;
    const error = thrownOf(settled);
    expect(error).toBeUltimateError('X_NOT_IMPLEMENTED');
    expect(String(Reflect.get(error as object, 'cause'))).toContain('the body');
    expect(settled.teardown).toEqual([
      expect.objectContaining({
        code: 'X_NOT_IMPLEMENTED',
        cause: expect.stringContaining('the drop'),
      }),
    ]);
  });
});

// The run's half of the same rule: what `withDrillFleet` kept must reach the result — the throw
// first, then every finished drill's failures and every teardown finding, red with exit 1.
describe('x drill · a drill that threw ends the run with every finding', () => {
  test('the throw, the earlier reports and the teardown findings are all in the result', () => {
    const held = { name: 'pg-down', verdict: { ok: true, failures: [] } };
    const failed = {
      name: 'pg-slow',
      verdict: {
        ok: false,
        failures: [
          { property: 'recovers' as const, expected: 'within 5000 ms', observed: 'never' },
        ],
      },
    };
    const teardown = { code: 'X_DRILL_TEARDOWN_FAILED', cause: 'slot still held', fix: 'x drill' };
    const result = thrownRun({
      thrown: new NotImplementedError({ cause: 'the body threw', fix: 'x drill --list --json' }),
      reports: [held, failed],
      teardowns: [teardown],
      notRun: ['redis-down'],
    });
    expect({ ok: result.ok, exitCode: result.exitCode }).toEqual({ ok: false, exitCode: 1 });
    expect(result.findings?.map((finding) => finding.code)).toEqual([
      'X_NOT_IMPLEMENTED',
      'X_DRILL_FAILED',
      'X_DRILL_TEARDOWN_FAILED',
    ]);
    expect(result.findings?.[1]?.cause).toContain('pg-slow');
    expect(result.findings?.[2]).toEqual(teardown);
    // The drill that threw counts as run and not held: 1 held of 3 ran, 1 not run.
    expect(result.summary).toStartWith('1 of 3 drill(s) held; 1 not run');
  });
});
