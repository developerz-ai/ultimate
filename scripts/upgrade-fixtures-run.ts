// One fixture, end to end: the release's own `x new` output (cached), `bun run setup` against the
// scope as npm served it that day, one commit — then this checkout's `x upgrade --to <HEAD>` over
// it, HEAD served as if published. Nothing between the two is an author's edit: the `.npmrc` that
// points the scope at loopback is excluded from git, so the hop sees the tree its author committed.

// why: Bun has no recursive copy, mkdtemp, mkdir or remove; the fixture tree is managed here.
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { LONG_RUN_TIMEOUT_MS, run } from './lib/run';
import { driftOf, readTree } from './upgrade-fixtures-drift';
import type { FixtureRun, FixtureStage } from './upgrade-fixtures-findings';
import type { PackedPackage } from './upgrade-fixtures-packument';
import { scopeLine } from './upgrade-fixtures-packument';
import { serveScope } from './upgrade-fixtures-registry';
import { commandDocument, readHop } from './upgrade-fixtures-verdict';

/** The scaffold's name: one app per temp directory, so every fixture can share it. */
export const FIXTURE_APP = 'fxapp';

/** A hop's gate runs the whole of `x verify` and `x exercise`: longer than any install. */
const HOP_TIMEOUT_MS = 1_200_000;

export interface FixtureInput {
  readonly root: string;
  readonly version: string;
  /** HEAD's version: the `--to` of the hop. */
  readonly head: string;
  readonly packed: readonly PackedPackage[];
  /** `node_modules/.cache/upgrade-fixtures`: scaffolds and npm packuments, for an offline re-run. */
  readonly cacheDir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly before: boolean;
  readonly verify: boolean;
  /** HEAD's own `x new` of the same name (`scaffoldHead`), which the hopped app is compared to. */
  readonly headScaffold: ReadonlyMap<string, string> | undefined;
}

const GIT = ['git', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid'];
const GIT_ENV = (env: Readonly<Record<string, string>>): Record<string, string> => ({
  ...env,
  GIT_CEILING_DIRECTORIES: tmpdir(),
});

/** The release's `x new` output, from the cache or from npm once — never with its `.git`. */
async function scaffold(input: FixtureInput): Promise<string | { output: string }> {
  const cached = join(input.cacheDir, 'scaffold', input.version, FIXTURE_APP);
  if (existsSync(join(cached, 'package.json'))) return cached;
  const parent = mkdtempSync(join(tmpdir(), `upgrade-fixture-new-${input.version}-`));
  try {
    const result = await run(
      [
        process.execPath,
        'x',
        `@ultimat3/cli@${input.version}`,
        'new',
        FIXTURE_APP,
        '--dir',
        parent,
        '--no-git',
        '--json',
      ],
      { cwd: parent, env: input.env, timeoutMs: LONG_RUN_TIMEOUT_MS },
    );
    if (!result.ok) return { output: result.output };
    rmSync(join(parent, FIXTURE_APP, '.git'), { recursive: true, force: true });
    mkdirSync(join(input.cacheDir, 'scaffold', input.version), { recursive: true });
    renameSync(join(parent, FIXTURE_APP), cached);
    return cached;
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

const porcelain = async (dir: string, env: Readonly<Record<string, string>>): Promise<string[]> => {
  const status = await run([...GIT, 'status', '--porcelain'], { cwd: dir, env: GIT_ENV(env) });
  return status.output
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3));
};

const commitAll = async (
  dir: string,
  env: Readonly<Record<string, string>>,
  message: string,
): Promise<boolean> => {
  const add = await run([...GIT, 'add', '-A'], { cwd: dir, env: GIT_ENV(env) });
  const commit = await run([...GIT, 'commit', '-q', '--allow-empty', '-m', message], {
    cwd: dir,
    env: GIT_ENV(env),
  });
  return add.ok && commit.ok;
};

/** `bun run verify --json`'s verdict line: whether the app's own gate is green, and its summary. */
async function gate(dir: string, env: Readonly<Record<string, string>>) {
  const result = await run([process.execPath, 'run', 'verify', '--json'], {
    cwd: dir,
    env,
    timeoutMs: HOP_TIMEOUT_MS,
  });
  const summary = commandDocument(result.output, 'verify')?.['summary'];
  return {
    green: result.ok,
    summary: typeof summary === 'string' ? summary : result.output.slice(-300),
  };
}

/** HEAD's own `x new` output for the fixture's name, read into memory; undefined when it fails. */
export async function scaffoldHead(
  root: string,
  env: Readonly<Record<string, string>>,
): Promise<ReadonlyMap<string, string> | undefined> {
  const parent = mkdtempSync(join(tmpdir(), 'upgrade-fixture-head-'));
  try {
    const result = await run(
      [
        process.execPath,
        join(root, 'packages', 'cli', 'src', 'bin.ts'),
        'new',
        FIXTURE_APP,
        '--dir',
        parent,
        '--no-git',
        '--json',
      ],
      { cwd: parent, env, timeoutMs: LONG_RUN_TIMEOUT_MS },
    );
    return result.ok ? await readTree(join(parent, FIXTURE_APP)) : undefined;
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

/** Builds the fixture at `version` and hops it to HEAD; every outcome is returned, none thrown. */
export async function runFixture(input: FixtureInput): Promise<FixtureRun> {
  const started = performance.now();
  const work = mkdtempSync(join(tmpdir(), `upgrade-fixture-${input.version}-`));
  const dir = join(work, FIXTURE_APP);
  const { env } = input;
  const elapsed = () => Math.round(performance.now() - started);
  // Wall time per stage, in run order: what decides whether a row fits a free runner's budget.
  const stages: Record<string, number> = {};
  let mark = performance.now();
  const lap = (stage: string): void => {
    stages[stage] = Math.round(performance.now() - mark);
    mark = performance.now();
  };
  const unbuilt = (stage: FixtureStage, output: string): FixtureRun => ({
    version: input.version,
    dir,
    unbuilt: { stage, output },
    before: null,
    wrote: [],
    after: null,
    drift: null,
    ms: elapsed(),
    stages,
  });

  const source = await scaffold(input);
  if (typeof source !== 'string') return unbuilt('scaffold', source.output);
  lap('scaffold');
  // Verbatim: `x new` writes AGENTS.md as a RELATIVE link, and a resolved one points outside the
  // app — Biome's walk dies on it ("path is expected to be under the root"), a red no author meets.
  cpSync(source, dir, { recursive: true, verbatimSymlinks: true });

  const packuments = join(input.cacheDir, 'packuments');
  const then = serveScope({ kind: 'as-of', version: input.version }, packuments);
  try {
    await run([...GIT, 'init', '-q'], { cwd: dir, env: GIT_ENV(env) });
    await Bun.write(join(dir, '.git', 'info', 'exclude'), '.npmrc\n');
    await Bun.write(join(dir, '.npmrc'), scopeLine(then.url));
    const setup = await run([process.execPath, 'run', 'setup'], {
      cwd: dir,
      env,
      timeoutMs: LONG_RUN_TIMEOUT_MS,
    });
    if (!setup.ok) return unbuilt('setup', setup.output);
  } finally {
    then.stop();
  }
  if (!(await commitAll(dir, env, `x new + bun run setup at ${input.version}`))) {
    return unbuilt('setup', 'git could not commit the scaffold');
  }
  lap('setup');
  const before = input.before ? await gate(dir, env) : null;
  // The gate at V may refresh tracked files it owns; the hop needs a clean tree either way.
  if (before !== null) {
    await commitAll(dir, env, `x verify at ${input.version}`);
    lap('before');
  }

  const now = serveScope({ kind: 'head', packed: input.packed }, packuments);
  try {
    await Bun.write(join(dir, '.npmrc'), scopeLine(now.url));
    // This checkout's CLI, as `bunx @ultimat3/cli@latest upgrade` would run it: the app's own older
    // CLI does not answer `upgrade` for it (`local-cli.ts`, OUTLIVES_THE_APP_CLI).
    const hop = await run(
      [
        process.execPath,
        join(input.root, 'packages', 'cli', 'src', 'bin.ts'),
        'upgrade',
        '--to',
        input.head,
        '--json',
      ],
      { cwd: dir, env, timeoutMs: HOP_TIMEOUT_MS },
    );
    lap('hop');
    const reading = readHop(commandDocument(hop.output, 'upgrade'));
    const wrote = await porcelain(dir, env);
    const after = input.verify ? await gate(dir, env) : null;
    if (after !== null) lap('after');
    const drift =
      input.headScaffold === undefined ? null : driftOf(input.headScaffold, await readTree(dir));
    return {
      version: input.version,
      dir,
      before,
      ...(reading === undefined ? { hopOutput: hop.output.slice(-800) } : { hop: reading }),
      wrote,
      after,
      drift,
      ms: elapsed(),
      stages,
    };
  } finally {
    now.stop();
  }
}
