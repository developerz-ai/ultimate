// `x exercise` end to end on a fixture app: the real pass, on a real scratch database. A handler
// that works is `reached`, one that throws is `unreached` and red with its override as the fix,
// `<name>` runs one primitive, and `--json`'s data is byte for byte what `.x/exercise.json` holds.
// Registries are process-global, so every test resets them.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
// Loaded here so its `mail.send` job registers before `beforeEach` isolates the registry: the first
// pass to import it would otherwise add a job the next pass in that test then counts.
import '@ultimat3/mail';
// why: Bun ships no recursive delete.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { action, resetActions, rpc, t } from '@ultimat3/action';
import { registerActions } from '@ultimat3/action/loader';
import { generateMigration } from '@ultimat3/db';
import { entity, text, uuid } from '@ultimat3/entity';
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
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { disk } from '@ultimat3/storage';
import { DEFAULT_SEED } from '@ultimat3/testing';
import { isolateEntityRegistry } from '@ultimat3/testing/registry-isolation';
import { REQUIRED_BUN } from './app-root';
import { exerciseCommand, exerciseRoles } from './cmd-exercise';
import type { CommandContext } from './command';
import { EXERCISE_REPORT_FILE } from './exercise-findings';
import { MIGRATIONS_DIR } from './migrations';
import type { FlagValue } from './parse';
import { processRoot } from './process-root-fixture';

const ROOT = processRoot(join(import.meta.dir, '..', '.exercise-fixture'));

const contextFor = (
  positionals: readonly string[] = [],
  flags: Readonly<Record<string, string>> = {},
): CommandContext => ({
  args: {
    command: 'exercise',
    subcommand: undefined,
    positionals,
    flags: new Map<string, FlagValue>([['seed', '7'], ...Object.entries(flags)]),
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

/** `cxWorks`, held so a page's typed client can name its shape. */
const cxWorks = action({
  input: t.object({ title: t.string.min(1).max(20) }),
  output: t.object({ ok: t.boolean }),
  policy: can('cx:write'),
  handle: async () => ({ ok: true }),
});

const register = (): void => {
  definePermissions(['cx:write'] as const);
  defineRoles({ writer: { grants: ['cx:write'] } });
  registerActions({
    cxWorks,
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
  clearRoutes();
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

  // The entry is already in the file: a paste would be a second `cxToggle:` key (TS1117), and the
  // next run proposed another one. The fix edits the entry it has.
  test('an unreached primitive with an entry already declared gets an edit, never a paste', async () => {
    broken = true;
    const file = join(ROOT, 'apps', 'web', 'exercise.ts');
    await Bun.write(
      file,
      "import { defineExercise } from '@ultimat3/testing';\n\nexport const exercise = defineExercise({\n  cxToggle: { empty: 'a fixture entry' },\n});\n",
    );
    try {
      const result = await exerciseCommand.run(contextFor());
      expect(outcomes(result.data)['cxToggle']).toBe('unreached');
      const finding = (result.findings ?? []).find(
        (one) => one.code === 'X_CONTRACT_EXERCISE_UNREACHED',
      );
      expect(finding?.fix).toStartWith('edit the cxToggle entry already in apps/web/exercise.ts');
      expect(finding?.fix).not.toContain('paste inside');
    } finally {
      await rm(join(ROOT, 'apps'), { recursive: true, force: true });
    }
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
    // The floor's one line; the empty-reach line beside it is `exercise-routes.test.ts`'s.
    const floor = warnings.filter((warning) => warning.startsWith('exercise left'));
    expect(floor).toHaveLength(1);
    expect(floor[0]).toContain('"unprovenMax": 0.3334');
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

  // A one-primitive run is a slice: 1 of 1 unproven is no ratio of the app, and the floor's
  // "lower it" advice off it was wrong — the whole-pass floor is judged on whole passes only.
  test('<name> on an unproven primitive is not judged against the whole-pass floor', async () => {
    unprovenRead();
    await Bun.write(
      join(ROOT, 'x.verify.json'),
      JSON.stringify({ exercise: { unprovenMax: 0.5, statementsMax: 1 } }),
    );
    try {
      const result = await exerciseCommand.run(contextFor(['cxFeed']));
      expect(Object.keys(outcomes(result.data))).toEqual(['cxFeed']);
      expect(result.findings ?? []).toEqual([]);
      expect((result.data as { warnings?: readonly string[] }).warnings).toBeUndefined();
      expect(result.ok).toBe(true);
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

  test("a route's load is run and reported beside the records; one that throws is a warning, never red", async () => {
    const page = (file: string, load: () => Promise<object>) =>
      registerRoute({
        file,
        config: defineRoute({
          render: 'ssr',
          offline: 'network-only',
          hydrate: 'never',
          budget: { js: '0kb' },
          load,
          meta: () => ({ title: 'a page', description: 'a page under test' }),
        }),
      });
    page('apps/web/app/cx/ok/page.tsx', async () => ({ ok: true }));
    page('apps/web/app/cx/broken/page.tsx', () => Promise.reject(new TypeError('the load broke')));
    const result = await exerciseCommand.run(contextFor());
    expect(result.ok).toBe(true);
    expect(result.findings ?? []).toEqual([]);
    const written = (await Bun.file(join(ROOT, EXERCISE_REPORT_FILE)).json()) as {
      routes?: readonly { name: string; outcome: string }[];
      warnings?: readonly string[];
    };
    expect(written.routes?.map((r) => [r.name, r.outcome])).toEqual([
      ['/cx/broken', 'unreached'],
      ['/cx/ok', 'reached'],
    ]);
    expect(written.warnings?.some((w) => w.includes('apps/web/app/cx/broken/page.tsx'))).toBe(true);
  }, 60_000);

  test('--shard i/n runs a disjoint slice per process, each in its own report', async () => {
    const shard = async (at: string) => {
      const result = await exerciseCommand.run(contextFor([], { shard: at }));
      const file = join(ROOT, '.x', `exercise.${at.replace('/', '-of-')}.json`);
      const written: unknown = await Bun.file(file).json();
      expect(written).toEqual(JSON.parse(JSON.stringify(result.data)));
      return Object.keys(outcomes(result.data));
    };
    const first = await shard('1/2');
    const second = await shard('2/2');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect([...first, ...second].sort()).toEqual(['cxToggle', 'cxWorks']);
  }, 60_000);

  test('--shard beside a <name>, or not i/n, is refused before anything runs', async () => {
    const codeOf = (ctx: CommandContext) =>
      exerciseCommand.run(ctx).then(
        () => 'ran',
        (error: unknown) => (error as { readonly code?: string }).code ?? 'uncoded',
      );
    expect(await codeOf(contextFor(['cxWorks'], { shard: '1/2' }))).toBe('X_VERIFY_SHARD_INVALID');
    expect(await codeOf(contextFor([], { shard: '3/2' }))).toBe('X_VERIFY_SHARD_INVALID');
  });

  describe('the seed', () => {
    /** The gate's own invocation: `x exercise --json`, no `--seed` on it. */
    const asTheGate = (): CommandContext => {
      const ctx = contextFor();
      (ctx.args.flags as Map<string, FlagValue>).delete('seed');
      return ctx;
    };

    interface Pass {
      readonly seed: unknown;
      readonly tenants: readonly string[];
      readonly verdict: unknown;
      readonly lines: readonly string[];
    }

    let tenants: string[] = [];
    // One value: a second registration under this name is only legal for the same action.
    const cxTenant = action({
      input: t.object({}),
      output: t.object({ ok: t.boolean }),
      policy: can('cx:write'),
      handle: async ({ ctx: call }) => {
        tenants.push(call.actor.orgId ?? '');
        return { ok: true };
      },
    });

    /** One pass, and the tenants its handler ran in: they are drawn from the seed, as row ids are. */
    const pass = async (ctx: CommandContext): Promise<Pass> => {
      tenants = [];
      registerActions({ cxTenant });
      const result = await exerciseCommand.run(ctx);
      const written = (await Bun.file(join(ROOT, EXERCISE_REPORT_FILE)).json()) as {
        seed: unknown;
        counts: unknown;
      };
      return {
        seed: written.seed,
        tenants,
        verdict: { ok: result.ok, findings: result.findings ?? [], counts: written.counts },
        lines: result.lines ?? [],
      };
    };

    // A table with a primary key: the rows are committed, so a second pass on this seed finding
    // the first's rows would die on the key. Each pass has to start on a scratch database.
    const withSeededTable = async (work: () => Promise<void>): Promise<void> => {
      const rows = entity('cx_seed_rows', {
        columns: { id: uuid().primaryKey(), label: text({ max: 40 }) },
      });
      const { up } = generateMigration({
        entities: [rows.$describe()],
        name: 'seed_rows',
        now: new Date('2026-11-18T00:00:00.000Z'),
      });
      await Bun.write(join(ROOT, MIGRATIONS_DIR, '0001_seed_rows.sql'), `${up}\n`);
      try {
        await work();
      } finally {
        await rm(join(ROOT, 'packages'), { recursive: true, force: true });
      }
    };

    test('two runs with no --seed use one seed, one set of rows and one verdict', async () => {
      await withSeededTable(async () => {
        const first = await pass(asTheGate());
        const second = await pass(asTheGate());
        expect(first.seed).toBe(DEFAULT_SEED);
        expect(second.seed).toBe(DEFAULT_SEED);
        expect(first.tenants.length).toBeGreaterThan(0);
        expect(second.tenants).toEqual(first.tenants);
        expect(second.verdict).toEqual(first.verdict);
      });
    }, 60_000);

    test('--seed overrides the default, and the run prints the seed that replays it', async () => {
      const gate = await pass(asTheGate());
      const other = await pass(contextFor([], { seed: '8' }));
      expect(other.seed).toBe(8);
      expect(other.tenants).not.toEqual(gate.tenants);
      expect(other.lines.some((line) => line.includes('x exercise --seed 8 --json'))).toBe(true);
    }, 60_000);

    test('--seed random explores a seed the report names, and that seed replays it', async () => {
      const explored = await pass(contextFor([], { seed: 'random' }));
      expect(explored.seed).toBeNumber();
      const replayed = await pass(contextFor([], { seed: String(explored.seed) }));
      expect(replayed.tenants).toEqual(explored.tenants);
      expect(replayed.verdict).toEqual(explored.verdict);
    }, 60_000);
  });

  // A page's load reads through the app's own typed client over APP_URL: answered in process.
  test("a route load calling the app's own API is answered in process, as its actor", async () => {
    const api = rpc<{ cxWorks: typeof cxWorks }>({
      get baseUrl() {
        return process.env['APP_URL'] ?? '';
      },
    });
    registerRoute({
      file: 'apps/web/app/cx/self/page.tsx',
      config: defineRoute({
        render: 'ssr',
        offline: 'network-only',
        hydrate: 'never',
        budget: { js: '0kb' },
        load: async () => api.cxWorks({ title: 'from the page' }),
        meta: () => ({ title: 'a page', description: 'a page under test' }),
      }),
    });
    const result = await exerciseCommand.run(contextFor());
    const routes = (result.data as { routes?: readonly { name: string; outcome: string }[] })
      .routes;
    expect(routes?.map((r) => [r.name, r.outcome])).toEqual([['/cx/self', 'reached']]);
  }, 60_000);
});
