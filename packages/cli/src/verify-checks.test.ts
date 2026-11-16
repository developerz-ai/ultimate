// The `lint` step, against the real biome: a red step names the file, the line and the rule, and its
// fix is one that does something. `bunx biome check --write .` printed "Skipped 1 suggested fixes".
// `contract-diff`'s baseline is the manifest at HEAD: `x manifest` cannot rebaseline it. One module
// that will not load is one finding, on `manifest`: every other step that loads the app stands down.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import type { RouteFact } from '@ultimat3/manifest';
import { buildManifest, MANIFEST_FILENAME } from '@ultimat3/manifest';
import type { TempTree } from '@ultimat3/testing';
import { tempTree } from '@ultimat3/testing';
import { writeAppManifest } from './app-manifest';
import { git } from './cmd-upgrade-fixture';
import { exec } from './exec';
import { lintFindings, lintOutcome } from './lint-findings';
import { LOAD_BLOCKED } from './load-findings';
import { workspaceRoot } from './scaffold-typecheck-fixture';
import { VERIFY_STEPS } from './verify-checks';
import { contractDiffOutcome, contractDiffStep } from './verify-contract-diff';

const BIOME = join(workspaceRoot(), 'node_modules/.bin/biome');
const CONFIG = JSON.stringify({
  files: { includes: ['bad.ts'] },
  linter: { rules: { correctness: { noUnusedVariables: 'error' } } },
});

let lint: TempTree | undefined;
let root = '';

const check = async () =>
  lintOutcome(
    await exec([BIOME, 'check', '--reporter=json', '--max-diagnostics=none', '.'], { cwd: root }),
  );

beforeAll(async () => {
  lint = tempTree('x-lint-findings-');
  root = lint.path;
  await Bun.write(join(root, 'biome.json'), CONFIG);
  // Biome holds its own config to its format: a finding about it is not what these read.
  await exec([BIOME, 'check', '--write', 'biome.json'], { cwd: root });
  await Bun.write(join(root, 'bad.ts'), 'const unused = 1;\nexport const used = 2;\n');
});

afterAll(() => lint?.dispose());

describe('the lint step', () => {
  test('an unused variable is a finding naming file, line and rule, with an edit as its fix', async () => {
    const outcome = await check();
    expect(outcome.ok).toBe(false);
    expect(outcome.findings).toHaveLength(1);
    const [finding] = outcome.findings;
    expect(finding?.code).toBe('X_LINT_FAILED');
    expect(finding?.at).toBe('bad.ts');
    expect(finding?.cause).toContain('bad.ts:1 lint/correctness/noUnusedVariables');
    // `--write` cannot repair it, so the fix does not claim it can.
    expect(finding?.fix).toStartWith(
      'bunx @biomejs/biome check bad.ts   # lint/correctness/noUnusedVariables: edit bad.ts:1,',
    );
    expect(finding?.fix).not.toContain('--write');
  });

  test('a formatting miss is told --write, and running that line turns it green', async () => {
    await Bun.write(join(root, 'bad.ts'), 'export const used   =   2\n');
    const outcome = await check();
    const fix = outcome.findings[0]?.fix ?? '';
    expect(fix).toBe('bunx @biomejs/biome check --write bad.ts');
    const argv = fix.replace('bunx @biomejs/biome', BIOME).split(' ');
    await exec(argv, { cwd: root });
    expect((await check()).ok).toBe(true);
  });

  test('the step asks biome for the report these read', async () => {
    const asked: (readonly string[])[] = [];
    const step = VERIFY_STEPS.find((one) => one.name === 'lint');
    await step?.run({
      root,
      runner: async (argv: readonly string[]) => {
        asked.push(argv);
        return { command: argv, code: 0, ok: true, stdout: '', stderr: '', durationMs: 0 };
      },
    } as never);
    expect(asked[0]).toContain('--reporter=json');
  });
});

describe('a report that is not one', () => {
  const red = (stdout: string) => ({
    command: [],
    code: 1,
    ok: false,
    stdout,
    stderr: 'biome: bad config',
    durationMs: 1,
  });

  test.each([
    ['not json'],
    ['{"diagnostics":"nope"}'],
    ['{"diagnostics":[]}'],
    ['{"diagnostics":[{"severity":"warning","category":"x","location":{"path":"a.ts"}}]}'],
  ])('%s keeps one finding pointing at the command, with what biome said', (stdout) => {
    const outcome = lintOutcome(red(stdout));
    expect(outcome.ok).toBe(false);
    expect(outcome.findings[0]?.fix).toBe('bunx @biomejs/biome check .');
    expect(outcome.output).toContain('bad config');
  });

  test('every file --write repairs is in ONE command; an edit stays its own finding', () => {
    const diagnostic = (path: string, category: string, line: number) => ({
      severity: 'error',
      category,
      message: 'm',
      location: { path, start: { line } },
    });
    const report = JSON.stringify({
      diagnostics: [
        diagnostic('a.ts', 'format', 1),
        diagnostic('b.ts', 'lint/style/useConst', 4),
        diagnostic('c.ts', 'assist/source/organizeImports', 1),
        diagnostic('a.ts', 'format', 9),
      ],
    });
    const findings = lintFindings(report) ?? [];
    expect(findings.map((one) => one.fix)).toEqual([
      'bunx @biomejs/biome check --write a.ts c.ts',
      'bunx @biomejs/biome check b.ts   # lint/style/useConst: edit b.ts:4, m',
    ]);
    expect(findings[0]?.cause).toBe(
      'a.ts:1 format: m; c.ts:1 assist/source/organizeImports: m; a.ts:9 format: m',
    );
    expect(findings[0]?.at).toBeUndefined();
    expect(findings[1]?.at).toBe('b.ts');
  });

  test('a path the shell would read is quoted', () => {
    const report = JSON.stringify({
      diagnostics: [
        { severity: 'error', category: 'format', message: 'm', location: { path: 'a;id.ts' } },
      ],
    });
    expect(lintFindings(report)?.[0]?.fix).toBe("bunx @biomejs/biome check --write 'a;id.ts'");
  });
});

describe('contract-diff · the baseline is the committed manifest', () => {
  const route = (url: string): RouteFact => ({
    url,
    render: 'ssr',
    offline: 'network-only',
    hydrate: 'never',
    revalidateTags: [],
    surface: 'site',
  });
  const published = buildManifest({
    app: { name: 'fixture', version: '1.0.0' },
    routes: [route('/posts'), route('/about')],
  });
  // `/about` removed, version unmoved: a breaking change no one decided on.
  const broken = buildManifest({
    app: { name: 'fixture', version: '1.0.0' },
    routes: [route('/posts')],
  });
  // One owner per repository: each tree removes itself once the git it ran has exited.
  const trees: TempTree[] = [];
  const owned = (prefix: string): string => {
    const tree = tempTree(prefix);
    trees.push(tree);
    return tree.path;
  };
  const app = async (repo: 'git' | 'none') => {
    const dir = owned('x-contract-diff-');
    if (repo === 'git') await git(dir, 'init', '-q');
    return dir;
  };
  const commit = async (dir: string) => {
    await git(dir, 'add', '-A');
    await git(dir, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'publish');
  };
  afterAll(async () => {
    await Promise.all(trees.splice(0).map((tree) => tree.dispose()));
  });

  test('`x manifest` after a breaking change does not turn contract-diff green', async () => {
    const dir = await app('git');
    await writeAppManifest(dir, published);
    await commit(dir);
    // What `x manifest` (and every `x g`) does next: rewrite the working-tree file.
    await writeAppManifest(dir, broken);
    const outcome = await contractDiffOutcome(dir, exec, broken);
    expect(outcome.ok).toBe(false);
    expect(outcome.findings.map((one) => one.code)).toEqual(['X_MANIFEST_BREAKING']);
    expect(outcome.findings[0]?.at).toBe(MANIFEST_FILENAME);
  });

  test('a major bump at HEAD and in the code is a decision, and is green', async () => {
    const dir = await app('git');
    await writeAppManifest(dir, published);
    await commit(dir);
    const bumped = { ...broken, app: { ...broken.app, version: '2.0.0' } };
    expect((await contractDiffOutcome(dir, exec, bumped)).ok).toBe(true);
  });

  test('a manifest never committed has published nothing to break, and says so', async () => {
    const dir = await app('git');
    await writeAppManifest(dir, published);
    await Bun.write(join(dir, 'README.md'), 'x\n');
    await git(dir, 'add', 'README.md');
    await git(dir, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'readme');
    const outcome = await contractDiffOutcome(dir, exec, broken);
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toContain('not committed at HEAD');
  });

  test('a repository with no commit yet has no baseline, and says so', async () => {
    const dir = await app('git');
    await writeAppManifest(dir, published);
    const outcome = await contractDiffOutcome(dir, exec, broken);
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toContain('no commit');
  });

  test('outside a git checkout the file on disk is the baseline, with a notice', async () => {
    const dir = await app('none');
    await writeAppManifest(dir, published);
    const outcome = await contractDiffOutcome(dir, exec, broken);
    expect(outcome.findings.map((one) => one.code)).toEqual(['X_MANIFEST_BREAKING']);
    expect(outcome.output).toContain('not a git checkout');
  });

  /** main publishes; a branch off it commits the rebaselined manifest — CI's HEAD on a PR. */
  const rebaselinedBranch = async () => {
    const dir = await app('git');
    await writeAppManifest(dir, published);
    await commit(dir);
    await git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    await git(dir, 'checkout', '-qb', 'feature');
    await writeAppManifest(dir, broken);
    await commit(dir);
    return dir;
  };

  test('in CI the merge base with GITHUB_BASE_REF is the baseline: a committed rebaseline is red', async () => {
    const dir = await rebaselinedBranch();
    const outcome = await contractDiffOutcome(dir, exec, broken, { GITHUB_BASE_REF: 'main' });
    expect(outcome.findings.map((one) => one.code)).toEqual(['X_MANIFEST_BREAKING']);
    expect(outcome.output).toContain('merge base with origin/main');
  });

  test('a depth-1 clone with a depth-1 fetched base (CI): the base ref is the baseline', async () => {
    const origin = await rebaselinedBranch();
    await git(origin, 'branch', '-q', 'main', 'origin/main');
    const dir = owned('x-contract-shallow-');
    const url = `file://${origin}`;
    await git(dir, 'clone', '-q', '--depth', '1', '--branch', 'feature', url, '.');
    await git(
      dir,
      'fetch',
      '-q',
      '--no-tags',
      '--depth',
      '1',
      'origin',
      'main:refs/remotes/origin/main',
    );
    // The shape `.github/workflows/ci.yml` leaves: no merge base is reachable.
    expect((await exec(['git', 'merge-base', 'HEAD', 'origin/main'], { cwd: dir })).ok).toBe(false);
    const outcome = await contractDiffOutcome(dir, exec, broken, { GITHUB_BASE_REF: 'main' });
    expect(outcome.findings.map((one) => one.code)).toEqual(['X_MANIFEST_BREAKING']);
    expect(outcome.output).not.toContain('git fetch');
  });

  test('a base that is not fetched falls back to HEAD and names the fetch', async () => {
    const dir = await rebaselinedBranch();
    const outcome = await contractDiffOutcome(dir, exec, broken, { GITHUB_BASE_REF: 'release' });
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toContain('git fetch --no-tags origin release');
  });

  test('the gate runs this step', () => {
    expect(VERIFY_STEPS.find((one) => one.name === 'contract-diff')?.summary).toBe(
      contractDiffStep.summary,
    );
  });
});

describe('a load failure is one finding, on manifest', () => {
  /** Every step that loads the app, bar its owner. `exercise` spawns `x exercise`, which does too. */
  const DEPENDENT = ['exercise', 'drift', 'contract-diff', 'budgets', 'seo', 'i18n', 'policy'];
  let tree: TempTree | undefined;
  let app = '';
  beforeAll(async () => {
    tree = tempTree('x-load-blocked-');
    app = tree.path;
    await Bun.write(join(app, 'app.config.ts'), 'export const config = {};\n');
    await Bun.write(join(app, 'package.json'), '{"name":"app","version":"1.0.0"}\n');
    await Bun.write(join(app, MANIFEST_FILENAME), '{}\n');
    await Bun.write(join(app, 'apps/web/app/post/entity.ts'), 'export const = ;\n');
  });
  afterAll(() => tree?.dispose());

  test.each(DEPENDENT)('%s stands down, finds nothing and spawns nothing', async (name) => {
    const step = VERIFY_STEPS.find((one) => one.name === name);
    const outcome = await step?.run({
      root: app,
      runner: async () => expect.unreachable(`${name} spawned a child over a broken load`),
    } as never);
    expect(outcome).toEqual({ ok: true, findings: [], output: LOAD_BLOCKED });
  });
});

describe('the drift step · an index nothing declares', () => {
  const tree = tempTree('x-drift-index-');
  const app = tree.path;
  afterAll(() => tree.dispose());

  // No migration records it and no entity names it. The dump also outruns the replay of zero
  // migrations, so the step is red on X_SCHEMA_DUMP_DRIFT — and the index is still only advice.
  test('X_DB_INDEX_UNDECLARED rides in warnings on main, never in the findings', async () => {
    await Bun.write(
      join(app, 'app.config.ts'),
      "import { defineConfig } from '@ultimat3/core';\nexport const config = defineConfig({ name: 'probe' });\n",
    );
    await Bun.write(
      join(app, 'packages/db/schema/05_indexes/posts.sql'),
      'CREATE INDEX posts_extra_idx ON public.posts USING btree (a);\n',
    );
    // One module, so the load reads an app rather than X_APP_EMPTY — which `loadApp` decides from
    // the PROCESS's registries, so it held here only while an earlier file's primitives were left.
    await Bun.write(join(app, 'apps/web/shared/tokens.ts'), 'export const tokens = {};\n');
    const drift = VERIFY_STEPS.find((step) => step.name === 'drift');
    if (drift === undefined) return expect.unreachable('no drift step');
    const outcome = await drift.run({ root: app, runner: exec });
    expect(outcome.findings.map((finding) => finding.code)).not.toContain('X_DB_INDEX_UNDECLARED');
    const warnings = outcome.warnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toStartWith(
      'X_DB_INDEX_UNDECLARED packages/db/schema/05_indexes/posts.sql: ',
    );
  }, 60_000);
});
