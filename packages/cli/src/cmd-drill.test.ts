// `x drill`'s refusals and its listing, on a fixture app: every refusal is decided before any
// process or database exists — an unknown drill, an unset service, a service the app does not use,
// a budget that is not a number — and a refusal is never a green run of nothing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { drillCommand } from './cmd-drill';
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
  test('--list names all eight drills and runs nothing', async () => {
    const result = await drillCommand.run(contextFor([], [['list', true]]));
    expect(result.ok).toBe(true);
    const data = result.data as { drills: { name: string; holds: string[] }[] };
    expect(data.drills.map((drill) => drill.name)).toHaveLength(8);
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
