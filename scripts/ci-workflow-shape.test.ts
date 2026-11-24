// The shape of `.github/workflows/ci.yml` that makes a gate run in PARTS still the gate: the parts
// are the step list exactly once, one job merges them and is the verdict, and every reader of a
// job's name still finds it. Reads the REAL workflows — each assertion is one a quiet edit to a
// matrix would otherwise unmake, and `x verify merge` would only notice after a push.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { NEW_SHAPES } from '../packages/cli/src/new-shapes';
import { planMatrix, verifyPlan } from '../packages/cli/src/verify-plan';
import { BESIDE_SERIAL_SUITES } from '../packages/cli/src/verify-run';
import { SHARDABLE_STEPS } from '../packages/cli/src/verify-shard';
import { VERIFY_STEP_NAMES } from '../packages/cli/src/verify-step';
import type { GatePart } from './lib/ci-parts';
import { partGaps, scriptCalls, shardSetGaps } from './lib/ci-parts';
import { expr, type Job, jobOf, planRows, readWorkflow, text } from './lib/ci-workflow-read';
import { PARTS_DIR } from './lib/coverage-parts';
import { GATED_APPS } from './lib/gated-apps';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import * as verifyArgs from './lib/verify-args';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const read = readWorkflow;

const ci = await read('ci.yml');
const job = (name: string): Job => jobOf(ci, name);
const FETCH_BASE = './.github/actions/fetch-base';
const runsOf = (target: Job): string =>
  (target.steps ?? []).map((step) => step.run ?? '').join('\n');
const allRuns = Object.values(ci.jobs ?? {})
  .map(runsOf)
  .join('\n');

const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

// The matrix is what the `tested` job's plan step writes, so the rows are READ BY RUNNING IT.
const planStep = (job('tested').steps ?? []).find((step) => step.id === 'plan');
const rows = await planRows(ci);

const parts: readonly GatePart[] = rows.map((row) => ({
  part: text(row['part']),
  only: text(row['only']).split(','),
  ...(text(row['shard']) === '' ? {} : { shard: text(row['shard']) }),
}));

describe('unit · ci.yml · the gate in parts is still the gate', () => {
  test('the parts run every gate step exactly once, and every shard of a split', () => {
    expect(parts.length).toBeGreaterThan(1);
    expect(partGaps(parts, VERIFY_STEP_NAMES, SHARDABLE_STEPS)).toEqual([]);
  });

  test('the static steps ride one unsharded part beside a serial suite, never alone', () => {
    // The runner puts them BESIDE the first serial suite listed (`verify-run.ts`); with none in the
    // list they run one after another — six whole-tree scans, ~400 s on a runner. `live` is split
    // across runners and a shard may name no other step, so their part is `eval`'s.
    const beside = parts.find((part) => part.only.includes('lint'));

    expect(beside).toBeDefined();
    expect([...BESIDE_SERIAL_SUITES].filter((step) => !beside?.only.includes(step))).toEqual([]);
    expect(beside?.only).toContain('eval');
    expect(beside?.shard).toBeUndefined();
  });

  test('live is split across runners, every shard a part of its own', () => {
    const live = parts.filter((part) => part.only.includes('live'));

    expect(live.length).toBeGreaterThan(1);
    for (const part of live) {
      expect(part.shard).toBeDefined();
      expect(part.only).toEqual(['live']);
    }
  });

  test('each part runs its own slice and nothing else: one --only, read from the matrix', () => {
    const run = runsOf(job('gate'));
    expect(run).toContain('bun run scripts/verify.ts --only "$ONLY"');
    const step = (job('gate').steps ?? []).find((candidate) =>
      text(candidate.run).includes('scripts/verify.ts'),
    );
    expect(step?.env?.['ONLY']).toBe(expr('matrix.only'));
    expect(step?.env?.['SHARD']).toBe(expr('matrix.shard'));
    expect(step?.env?.['PART']).toBe(expr('matrix.part'));
  });

  test('a red part still hands the verdict its document, and does not cancel the others', () => {
    const upload = (job('gate').steps ?? []).find((step) =>
      text(step.uses).startsWith('actions/upload-artifact@'),
    );
    expect(upload?.if).toBe(expr('!cancelled()'));
    // Per attempt: a re-run's document must not share a name with the one it replaces.
    expect(upload?.with?.['name']).toBe(
      `verify-part-${expr('matrix.part')}-attempt-${expr('github.run_attempt')}`,
    );
    expect(upload?.with?.['path']).toBe(
      `${expr('runner.temp')}/parts/${expr('matrix.part')}.attempt-${expr('github.run_attempt')}.json`,
    );
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    expect(job('gate').strategy?.['fail-fast']).toBe(false);
  });

  test('verify merges every part and runs when a part is red — a skipped verdict is no verdict', () => {
    const verify = job('verify');
    expect(
      listOf(verify.needs).concat(typeof verify.needs === 'string' ? [verify.needs] : []),
    ).toContain('gate');
    // Skipped only when a green PR run already tested this tree (`ci-workflow-shape-tested.test.ts`).
    expect(verify.if).toBe(expr("!cancelled() && needs.tested.outputs.tested != 'true'"));
    const download = (verify.steps ?? []).find((step) =>
      text(step.uses).startsWith('actions/download-artifact@'),
    );
    expect(download?.with?.['pattern']).toBe('verify-part-*');
    expect(download?.with?.['merge-multiple']).toBe(true);
    // The human render for the log, then the same merge's document for the bounded summary
    // (`scripts/ci-workflow-shape-runs.test.ts`).
    expect(scriptCalls(runsOf(verify), 'scripts/verify.ts')).toEqual([
      { subcommand: 'merge', flags: [] },
      { subcommand: 'merge', flags: ['json'] },
    ]);
    // Only each part's newest attempt is merged, never the whole download directory.
    expect(runsOf(verify)).not.toContain('/*.json');
    expect(runsOf(verify)).toContain(
      `scripts/verify-parts.ts ${text(download?.with?.['path'])} --json | jq -r '.data[]'`,
    );
    expect(runsOf(verify)).toContain(['merge "$', '{docs[@]}"'].join(''));
  });

  test('every flag and subcommand ci.yml hands scripts/verify.ts is one that script accepts', () => {
    const calls = scriptCalls(allRuns, 'scripts/verify.ts');
    const flags = [...new Set(calls.flatMap((call) => call.flags))].sort();
    const subcommands = [...new Set(calls.flatMap((call) => call.subcommand ?? []))];
    // Read off the module rather than imported by name: a subcommand list this script does not
    // export yet must be a failing assertion here, never a file that cannot load.
    const accepted = (verifyArgs as { readonly VERIFY_SUBCOMMANDS?: readonly string[] })
      .VERIFY_SUBCOMMANDS;

    expect(calls.length).toBeGreaterThan(1);
    expect(
      flags.filter((flag) => !(verifyArgs.VERIFY_FLAGS as readonly string[]).includes(flag)),
    ).toEqual([]);
    expect(subcommands.filter((name) => !(accepted ?? []).includes(name))).toEqual([]);
  });
});

describe('unit · ci.yml · every reader of a job name still finds it', () => {
  // release.yml reads this WORKFLOW's run conclusion, so no job name is its contract any more —
  // but `verify` stays the merge and the one check branch protection would require.
  test('release.yml reads ci.yml`s whole run, and verify is still the merge job', async () => {
    const release = await read('release.yml');
    const check = (release.jobs?.['check']?.steps ?? []).map((step) => step.run ?? '').join('\n');

    expect(check).toContain('actions/workflows/ci.yml/runs');
    expect(check).not.toContain('select(.name == "verify"');
    // No `name:` — the check a job publishes is its id unless it is renamed.
    expect(job('verify').name).toBeUndefined();
    expect(job('verify').strategy).toBeUndefined();
  });

  test('deploy-social-demo.yml reads the demo app’s own gate, by the name its matrix job has', async () => {
    const deploy = await read('deploy-social-demo.yml');
    const checks = (deploy.jobs?.['build']?.steps ?? []).flatMap(
      (step) => step.env?.['CHECK'] ?? [],
    );
    const demo = 'dummy/social-media-clone';

    expect(GATED_APPS.map((app) => app.dir)).toContain(demo);
    expect(job('reference-app-verify').name).toBe(`reference-app-verify (${expr('matrix.app')})`);
    expect(checks).toEqual([`reference-app-verify (${demo})`]);
  });

  test('each tracked app has a runner: the matrix is the gated-apps table', () => {
    const apps = job('reference-app-verify');
    expect(listOf(apps.strategy?.matrix?.['app'])).toEqual(GATED_APPS.map((app) => app.dir));
    expect(apps.strategy?.['fail-fast']).toBe(false);
    expect(runsOf(apps)).toContain('scripts/reference-app-gate.ts --app "$APP"');
  });

  test('the packages shards are every shard of one split, and no package is named here', () => {
    const packages = job('packages');
    const shards = listOf(packages.strategy?.matrix?.['shard']).map(text);

    expect(shardSetGaps('packages', shards)).toEqual([]);
    expect(packages.strategy?.['fail-fast']).toBe(false);
    expect(runsOf(packages)).toContain('scripts/coverage-gate.ts --all --shard "$SHARD"');
  });

  // A shard holding part of a cut unit only measures it: the unit is judged where the parts meet.
  test('every part a packages shard writes reaches packages (merge), which judges the fold', () => {
    const upload = (job('packages').steps ?? []).find((step) =>
      text(step.uses).startsWith('actions/upload-artifact@'),
    );
    expect(text(upload?.with?.['path'])).toBe(`${PARTS_DIR}/`);
    expect(upload?.with?.['include-hidden-files']).toBe(true);
    expect(text(upload?.with?.['name'])).toStartWith('coverage-part-');
    const merge = job('packages-merge');
    const download = (merge.steps ?? []).find((step) =>
      text(step.uses).startsWith('actions/download-artifact@'),
    );
    expect(text(download?.with?.['pattern'])).toBe('coverage-part-*');
    expect(runsOf(merge)).toContain(
      'scripts/coverage-gate.ts --merge "$RUNNER_TEMP/coverage-parts"',
    );
  });

  // Run 42941773147: `packages (2/3)` had no origin/main, so every `scripts/*.test.ts` worker that
  // calls `baseRef()` fetched it AT ONCE; the losers died on `.git/shallow.lock` and one test read
  // `undefined`. Each job running those tests fetches the base ONCE, before any test starts.
  test('every job that runs the scripts tests fetches origin/main before them', () => {
    for (const name of ['gate', 'packages']) {
      const uses = (job(name).steps ?? []).map((step) => text(step.uses));
      expect(uses, name).toContain(FETCH_BASE);
    }
  });

  // #1328: the base was main's tip at fetch time, so a pull request merged mid-run put its files
  // in this run's diff (X_CHANGELOG_UNRELEASED_EMPTY on a scripts-only change). Every fetch of the
  // base goes through the one action, which pins a pull request to its merge commit's first parent.
  test('origin/main is fetched as the run base, never as a moving tip', async () => {
    expect(allRuns).not.toContain('refs/heads/main:refs/remotes/origin/main');
    for (const name of ['flaky', 'release-rehearsal', 'gate', 'packages']) {
      expect(
        (job(name).steps ?? []).filter((step) => text(step.uses) === FETCH_BASE),
        name,
      ).toHaveLength(1);
    }
    const action = await Bun.file(`${repoRoot()}/.github/actions/fetch-base/action.yml`).text();
    expect(action).toContain('if [ "$GITHUB_EVENT_NAME" = pull_request ]; then');
    expect(action).toContain(`base="$(git cat-file -p HEAD | sed -n 's/^parent //p' | head -1)"`);
    expect(action).toContain(
      'git fetch --no-tags --depth=1 origin "+$base:refs/remotes/origin/main"',
    );
  });
});

describe('unit · ci.yml · the gate matrix is `x verify plan`, never typed here', () => {
  // `gate` already waits on `tested`, so the plan rides there: no runner and no wait of its own.
  const tested = job('tested');

  test('the gate reads the tested job`s plan through fromJSON', () => {
    const matrix: unknown = job('gate').strategy?.matrix;
    expect(matrix).toBe(expr('fromJSON(needs.tested.outputs.matrix)'));
    expect(record(record(tested)['outputs'])['matrix']).toBe(expr('steps.plan.outputs.matrix'));
    expect(text(planStep?.run)).toContain('bun run x -- verify plan --parts "$PARTS"');
    // A pull request needs the plan too: the checkout, the install and the plan run on every event.
    const upToPlan = (tested.steps ?? []).slice(0, (tested.steps ?? []).indexOf(planStep ?? {}));
    const uses = upToPlan.map((step) => text(step.uses).split('@')[0]);
    expect(uses).toEqual(['actions/checkout', './.github/actions/setup']);
    expect([...upToPlan, planStep].filter((step) => step?.if !== undefined)).toEqual([]);
  });

  test('the rows are the plan, each with the test services its level of need names', () => {
    const plan = planMatrix(verifyPlan(Number(planStep?.env?.['PARTS'])));
    expect(rows.map(({ services, urls, ...row }) => row)).toEqual(plan.include.map(record));
    const given = (row: Readonly<Record<string, unknown>>): string =>
      `${text(row['needs'])}: ${text(row['services'])} ${text(row['urls'])}`;
    expect([...new Set(rows.map(given))].filter((one) => !one.startsWith('services'))).toEqual([
      'database: postgres TEST_DATABASE_URL',
      'none:  ',
    ]);
  });
});

describe('unit · ci.yml · the embedded Postgres boots from a cached snapshot', () => {
  // `x db gen` and the `drift` step replay migrations on a scratch PGlite, whose first boot per
  // checkout is an `initdb` (~3.0 s measured, against ~0.75 s restored). The post-`initdb`
  // snapshot lives under the APP's own `.x/cache`, named for the PGlite version that wrote it.
  const SNAPSHOTS = '.x/cache/pglite-*.snapshot';
  const cached = [
    {
      name: 'reference-app-verify',
      root: expr('matrix.app'),
      before: 'reference-app-gate.ts',
      scaffold: false,
    },
    {
      name: 'scaffold-smoke',
      root: `${expr('runner.temp')}/${expr('matrix.app')}`,
      before: 'scaffold-smoke-steps.ts',
      scaffold: true,
    },
  ];
  const cacheStep = (target: Job): number =>
    (target.steps ?? []).findIndex(
      (step) =>
        text(step.uses).startsWith('actions/cache@') &&
        text(step.with?.['path']).endsWith(SNAPSHOTS),
    );

  test('every job that boots one restores it from the app`s own .x/cache, before the boot', () => {
    for (const { name, root, before, scaffold } of cached) {
      const steps = job(name).steps ?? [];
      const at = cacheStep(job(name));
      expect({ [name]: at >= 0 }).toEqual({ [name]: true });
      expect(steps[at]?.with?.['path']).toBe(`${root}/${SNAPSHOTS}`);
      const boots = steps.findIndex((step) => text(step.run).includes(before));
      expect(boots).toBeGreaterThan(at);
      // After `x new`: the scaffold refuses a directory that already exists. Per job, and the
      // presence first: a bare `toBeLessThan(at)` passed on the -1 of a job that never scaffolds,
      // so deleting `x -- new` from scaffold-smoke left it green (`bun run index-of-order`).
      const scaffolds = steps.findIndex((step) => text(step.run).includes('x -- new'));
      if (scaffold) {
        expect(scaffolds).toBeGreaterThanOrEqual(0);
        expect(scaffolds).toBeLessThan(at);
      } else {
        expect({ [name]: scaffolds }).toEqual({ [name]: -1 });
      }
    }
  });

  test('the key is the PGlite version bun.lock pins, and the snapshot format', () => {
    for (const { name } of cached) {
      const steps = job(name).steps ?? [];
      const key = text(steps[cacheStep(job(name))]?.with?.['key']);
      expect(key).toContain(expr('steps.pglite.outputs.version'));
      // A format bump renames the file, so a key that ignored it would hit on a file nobody reads.
      expect(key).toContain(expr("hashFiles('packages/db/src/pglite-snapshot.ts')"));
      const version = steps.findIndex((step) => step.id === 'pglite');
      expect(version).toBeGreaterThanOrEqual(0);
      expect(version).toBeLessThan(cacheStep(job(name)));
      expect(text(steps[version]?.run)).toContain('bun.lock');
    }
  });

  test('the version step reads the one version the real bun.lock resolves', async () => {
    const root = repoRoot();
    const run = text((job('reference-app-verify').steps ?? []).find((s) => s.id === 'pglite')?.run);
    const pattern = /grep -om1 '([^']+)' bun\.lock/.exec(run)?.[1];
    expect(pattern).toBeDefined();
    const found = new RegExp(pattern ?? '$^').exec(await Bun.file(`${root}/bun.lock`).text())?.[0];
    const manifest: unknown = await Bun.file(`${root}/package.json`).json();
    const pinned = text(record(record(manifest)['devDependencies'])['@electric-sql/pglite']);
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(found).toBe(`"@electric-sql/pglite@${pinned}"`);
    expect(run).toContain('>> "$GITHUB_OUTPUT"');
  });

  test('the framework gate has none: the repo root declares no migration to replay', async () => {
    expect(cacheStep(job('gate'))).toBe(-1);
    const migrations = new Bun.Glob('packages/db/migrations/*').scan({ cwd: repoRoot() });
    expect((await Array.fromAsync(migrations)).length).toBe(0);
  });
});

describe('unit · ci.yml · scaffold-smoke opens the app it scaffolded', () => {
  test('the admin walk runs last: after the generators, and after the setup that migrates them', () => {
    const steps = job('scaffold-smoke').steps ?? [];
    const at = (needle: string): number[] =>
      steps.flatMap((step, index) => (text(step.run).includes(needle) ? [index] : []));
    const [walk, ...again] = at('scripts/scaffold-admin.ts "$RUNNER_TEMP/$APP"');
    expect(walk).toBeDefined();
    expect(again).toEqual([]);
    // The resource it asks for is the one the sweep generates, and its table exists only once the
    // second `bin/setup` has applied that migration.
    expect(at('scripts/scaffold-first-run.ts')[0]).toBeLessThan(walk ?? -1);
    expect(at('scripts/scaffold-smoke-steps.ts').at(-1)).toBeLessThan(walk ?? -1);
    expect(at('scripts/scaffold-smoke-steps.ts')).toHaveLength(2);
  });

  // A shape `x new` accepts is one a stranger can pick, so it gates on a runner of its own: a
  // name in `NEW_SHAPES` with no row here is a scaffold nothing has ever run `bun run verify` on.
  test('the matrix is the default, --no-example, one row per x new --shape, and the monorepo', () => {
    const include = listOf(job('scaffold-smoke').strategy?.matrix?.['include']).map(record);
    expect(include.map((row) => text(row['flags']))).toEqual([
      '',
      '--no-example',
      ...NEW_SHAPES.map((shape) => `--shape ${shape}`),
      // `multiapp`: the default scaffold grown by `x g app` and `x g package` (plan 101, 22 M1).
      '',
    ]);
    expect(text(include.at(-1)?.['app'])).toBe('multiapp');
  });
});

describe('unit · ci.yml · what a red part prints', () => {
  test('the step table counts errored files, and no comment asks for a flag that exists', async () => {
    expect(runsOf(job('gate'))).toContain(
      String.raw`\(.tests.ran) ran, \(.tests.skipped) skipped\(if .tests.errors then ", \(.tests.errors) errored" else "" end)`,
    );
    const raw = await Bun.file(`${repoRoot()}/.github/workflows/ci.yml`).text();
    expect(raw).not.toContain('# NEEDS `--shard');
  });
});
