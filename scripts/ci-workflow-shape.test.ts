// The shape of `.github/workflows/ci.yml` that makes a gate run in PARTS still the gate: the parts
// are the step list exactly once, one job merges them and is the verdict, and every reader of a
// job's name still finds it. Reads the REAL workflows — each assertion is one a quiet edit to a
// matrix would otherwise unmake, and `x verify merge` would only notice after a push.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { BESIDE_SERIAL_SUITES } from '../packages/cli/src/verify-run';
import { SHARDABLE_STEPS } from '../packages/cli/src/verify-shard';
import { VERIFY_STEP_NAMES } from '../packages/cli/src/verify-step';
import type { GatePart } from './lib/ci-parts';
import { partGaps, scriptCalls, shardSetGaps } from './lib/ci-parts';
import { expr, type Job, jobOf, readWorkflow, text } from './lib/ci-workflow-read';
import { GATED_APPS } from './lib/gated-apps';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import * as verifyArgs from './lib/verify-args';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const read = readWorkflow;

const ci = await read('ci.yml');
const job = (name: string): Job => jobOf(ci, name);
const runsOf = (target: Job): string =>
  (target.steps ?? []).map((step) => step.run ?? '').join('\n');
const allRuns = Object.values(ci.jobs ?? {})
  .map(runsOf)
  .join('\n');

const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const parts: readonly GatePart[] = listOf(job('gate').strategy?.matrix?.['include']).map((raw) => {
  const row = record(raw);
  const shard = text(row['shard']);
  return {
    part: text(row['part']),
    only: text(row['only']).split(','),
    ...(shard === '' ? {} : { shard }),
  };
});

describe('unit · ci.yml · the gate in parts is still the gate', () => {
  test('the parts run every gate step exactly once, and every shard of a split', () => {
    expect(parts.length).toBeGreaterThan(1);
    expect(partGaps(parts, VERIFY_STEP_NAMES, SHARDABLE_STEPS)).toEqual([]);
  });

  test('the static steps ride the part that runs live, where they cost no wall time', () => {
    // The runner puts them BESIDE the serial suites only when `live` is in the same list. In any
    // other part they run one after another, alone — a runner and two minutes for nothing.
    const live = parts.find((part) => part.only.includes('live'));

    expect(live).toBeDefined();
    expect([...BESIDE_SERIAL_SUITES].filter((step) => !live?.only.includes(step))).toEqual([]);
    expect(live?.shard).toBeUndefined();
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
    expect(verify.if).toBe(expr('!cancelled()'));
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
      before: 'scaffold-gate.ts',
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
    expect(at('scripts/scaffold-gate.ts').at(-1)).toBeLessThan(walk ?? -1);
    expect(at('scripts/scaffold-gate.ts')).toHaveLength(2);
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

describe('unit · ci.yml · what the split may not change', () => {
  test('free runners only: ubuntu-latest, and windows-latest for the windows job alone', () => {
    // `windows-latest` is free because the repository is public; it is admitted for the one job
    // whose question is the platform, never as a second place to run a Linux job.
    const allowed = (name: string): string =>
      name === 'windows' ? 'windows-latest' : 'ubuntu-latest';
    const runners = Object.entries(ci.jobs ?? {}).map(([name, target]) => [
      name,
      target['runs-on'],
    ]);
    expect(runners.filter(([name, runner]) => runner !== allowed(name ?? ''))).toEqual([]);
    expect(job('windows')['runs-on']).toBe('windows-latest');
  });

  test('a missing browser is a refusal in CI, never a skip', () => {
    expect(ci.env?.['E2E_BROWSER_REQUIRED']).toBe('1');
    expect(ci.env?.['ULTIMATE_TEST_SEED']).toBe('20260101');
  });

  // A job or a step allowed to fail is not part of the gate: the run concludes `success` over it,
  // and that conclusion is the one `release.yml` publishes on. Both scopes, in every job — a step
  // marked `continue-on-error` hides its red exactly as a job marked so does.
  test('every job and every step is required — no continue-on-error at either scope', () => {
    const optional = Object.entries(ci.jobs ?? {}).flatMap(([name, target]) => [
      ...(target['continue-on-error'] === undefined ? [] : [name]),
      ...(target.steps ?? [])
        .filter((step) => step['continue-on-error'] !== undefined)
        .map((step) => `${name} › ${step.name ?? step.uses ?? step.run ?? '?'}`),
    ]);
    expect(optional).toEqual([]);
  });

  test('no job in the gate waits on a job outside it', () => {
    for (const name of [
      'gate',
      'reference-app-verify',
      'scaffold-smoke',
      'container',
      'packages',
      'windows',
    ]) {
      expect(job(name).needs, `${name} must not wait on another job`).toBeUndefined();
    }
  });
});

describe('unit · ci.yml · deploy-proof inherits a verdict only from a proof that passed', () => {
  // K15: the path filter diffed against `github.event.before` alone, so a red proof on A was
  // hidden by a B that touched no deciding path, and release.yml published from B. The decision
  // is now one unit-tested script (`scripts/deploy-proof-due.test.ts`); this holds ci.yml to it.
  const proof = job('deploy-proof');
  const steps = proof.steps ?? [];
  const decide = steps.findIndex((step) => step.id === 'paths');

  test('the decision is scripts/deploy-proof-due.ts, reading the API with the run`s own token', () => {
    expect(decide).toBeGreaterThanOrEqual(0);
    expect(text(steps[decide]?.run).trim()).toBe('bun run scripts/deploy-proof-due.ts');
    expect(steps[decide]?.env?.['GH_TOKEN']).toBe(expr('github.token'));
    expect(proof.permissions).toEqual({ contents: 'read', actions: 'read' });
    // The script runs on Bun, so the setup is not behind the decision any more.
    const setup = steps.findIndex((step) => step.uses === './.github/actions/setup');
    expect(setup).toBeGreaterThanOrEqual(0);
    expect(setup).toBeLessThan(decide);
    expect(steps[setup]?.if).toBeUndefined();
  });

  test('no second filter beside it, and every step after it obeys it', () => {
    expect(JSON.stringify(steps)).not.toContain('event.before');
    const after = steps.slice(decide + 1);
    expect(after.length).toBeGreaterThan(0);
    for (const step of after) expect(step.if).toBe("steps.paths.outputs.run == 'true'");
  });
});

describe('unit · ci.yml · the TLS replication suite runs in CI', () => {
  // #519: `pg-tls.live.test.ts` skipped in every run because nothing started a TLS server or
  // exported its CA — a live step green over a suite that never ran.
  const live = record(
    listOf(job('gate').strategy?.matrix?.['include']).find((row) => record(row)['part'] === 'live'),
  );

  test('the live part starts postgres-tls and exports its URL and its CA', () => {
    expect(text(live['services']).split(' ')).toContain('postgres-tls');
    const urls = text(live['urls']).split('|');
    expect(urls).toContain('TEST_TLS_REPLICATION_URL');
    expect(urls).toContain('TEST_TLS_ROOT_CERT');
  });

  test('the suite dials 5440, the port compose publishes, and trusts the CA compose writes', async () => {
    const root = repoRoot();
    const env = new Map(
      (await Bun.file(`${root}/docker/test-services.env`).text())
        .split('\n')
        .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    const compose = Bun.YAML.parse(
      await Bun.file(`${root}/docker/docker-compose.test.yml`).text(),
    ) as { readonly services?: Readonly<Record<string, Readonly<Record<string, unknown>>>> };
    const tls = compose.services?.['postgres-tls'] ?? {};

    expect(new URL(env.get('TEST_TLS_REPLICATION_URL') ?? 'x:').port).toBe('5440');
    expect(listOf(tls['ports'])).toEqual(['127.0.0.1:5440:5432', '127.0.0.2:5440:5432']);
    expect(listOf(tls['command']).join(' ')).toContain('wal_level=logical');
    expect(listOf(tls['command']).join(' ')).toContain('ssl=on');
    // Repo-relative, as every suite runs from the root; the directory is the one compose mounts.
    expect(env.get('TEST_TLS_ROOT_CERT')).toBe('docker/.tls/ca.crt');
    expect(listOf(tls['volumes'])).toContain('./.tls:/tls:ro');
  });
});
