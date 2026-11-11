// The large synthetic app `boot-large-app.bench.ts` boots: the reference app as committed at HEAD
// (`git archive`, so a teammate's uncommitted edit never lands in a figure) plus N resources made
// by the real `x g resource` — an entity, a policy, actions, a live query, a job, a page, an
// island and their tests each, imports and all — the plan's 5k-file app, rebuilt on demand.
// Written under the root's ignored `.x/`: inside the repo, so an island's bundle resolves
// `solid-js` from the root install as `examples/dummy`'s does, and never under a `node_modules`,
// whose segment anywhere in a module's ABSOLUTE path makes the scan skip it (`isScannedModule`).

// why: Bun ships no directory create, listing or recursive delete of its own.
import { mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { quoteArg } from '../../packages/cli/src/shell-quote';
import { repoRoot } from '../lib/run';
import { ScriptError } from '../lib/script-error';
import type { AppShape } from './boot-large-app-shape';
import { countsAsSource, manifestCounts, resourceName } from './boot-large-app-shape';

export const X_BIN = (): string => `${repoRoot()}/packages/cli/src/bin.ts`;

/** The directory the bench owns whole: the app, and nothing else, under it. */
export const fixtureParent = (): string => `${repoRoot()}/.x/bench-large-app`;

export const fixtureDir = (): string => `${fixtureParent()}/app`;

/** `examples/dummy`'s installed `node_modules`, at the app root and in each workspace member. */
async function installedModules(source: string): Promise<string[]> {
  const found = ['node_modules'];
  for (const group of ['apps', 'packages']) {
    for (const member of await readdir(`${source}/${group}`).catch(() => [])) {
      const rel = `${group}/${member}/node_modules`;
      if ((await readdir(`${source}/${rel}`).catch(() => undefined)) !== undefined) found.push(rel);
    }
  }
  return found;
}

/** A command that must succeed; its stdout, or `X_BENCH_RUN_FAILED` naming it. */
export function runOrThrow(cmd: readonly string[], cwd: string, what: string): string {
  const done = Bun.spawnSync([...cmd], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 600_000 });
  if (done.exitCode !== 0) {
    throw new ScriptError({
      code: 'X_BENCH_RUN_FAILED',
      cause: `${what} exited ${String(done.exitCode)}: ${done.stderr.toString().slice(-600)}`,
      // Built as words, never a template: every value is quoted on its own by `quoteArg`.
      fix: ['cd', quoteArg(cwd), '&&', ...cmd.map(quoteArg)].join(' '),
    });
  }
  return done.stdout.toString();
}

/**
 * Each install linked entry by entry, by absolute path (the committed links are relative to
 * `examples/dummy/` and would dangle here), into a REAL `node_modules`: the prebuilt store is
 * written under `node_modules/.cache/`, and a linked directory would put the fixture's store in
 * the reference app's own install.
 */
async function linkInstalls(source: string, dir: string): Promise<void> {
  for (const rel of await installedModules(source)) {
    await rm(`${dir}/${rel}`, { recursive: true, force: true });
    await mkdir(`${dir}/${rel}`, { recursive: true });
    for (const entry of await readdir(`${source}/${rel}`)) {
      if (entry === '.cache') continue;
      await symlink(`${source}/${rel}/${entry}`, `${dir}/${rel}/${entry}`);
    }
  }
}

/** The reference app at HEAD, its installs linked, then `resources` generated slices. */
export async function writeLargeApp(resources: number, dir = fixtureDir()): Promise<string> {
  const root = repoRoot();
  const source = `${root}/examples/dummy`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const archive = Bun.spawnSync(['git', 'archive', '--format=tar', 'HEAD', 'examples/dummy'], {
    cwd: root,
    stdout: 'pipe',
    timeout: 120_000,
  });
  if (archive.exitCode !== 0) {
    throw new ScriptError({
      code: 'X_BENCH_RUN_FAILED',
      cause: 'git archive HEAD examples/dummy failed, so there is no reference app to grow',
      fix: 'git -C . archive --format=tar HEAD examples/dummy | tar -t | head',
    });
  }
  const untar = Bun.spawnSync(['tar', '-x', '--strip-components=2', '-C', dir], {
    stdin: archive.stdout,
    timeout: 120_000,
  });
  if (untar.exitCode !== 0) {
    throw new ScriptError({
      code: 'X_BENCH_RUN_FAILED',
      cause: `tar could not unpack the reference app into ${dir}`,
      fix: `rm -rf ${quoteArg(dir)} && bun run scripts/bench/boot-large-app.bench.ts --resources 1 --runs 1`,
    });
  }
  await linkInstalls(source, dir);
  for (let index = 1; index <= resources; index += 1) {
    const name = resourceName(index);
    // `x g resource` exits non-zero on `X_PERMISSION_UNGRANTED` — the reference app's roles live
    // in a module it does not edit — after writing every file. The slice's directory is the proof
    // it was generated; an ungranted permission answers 403 on its endpoints, never on `/`.
    Bun.spawnSync(['bun', X_BIN(), 'g', 'resource', name], {
      cwd: dir,
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: 120_000,
    });
    if (!(await Bun.file(`${dir}/apps/web/app/${name}/policy.ts`).exists())) {
      throw new ScriptError({
        code: 'X_BENCH_RUN_FAILED',
        cause: `x g resource ${name} wrote no apps/web/app/${name}/policy.ts in the fixture`,
        fix: `cd ${quoteArg(dir)} && bun ${quoteArg(X_BIN())} g resource ${quoteArg(name)}`,
      });
    }
  }
  return dir;
}

/** What the fixture is: its TS file count, its islands, and the manifest's primitive counts. */
export async function appShape(dir: string, resources: number): Promise<AppShape> {
  const files = [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: dir, followSymlinks: false })];
  const sources = files.filter(countsAsSource);
  const manifest: unknown = await Bun.file(`${dir}/x.manifest.json`)
    .json()
    .catch(() => undefined);
  return {
    resources,
    tsFiles: sources.length,
    islands: sources.filter((file) => file.endsWith('.island.tsx')).length,
    ...manifestCounts(manifest),
  };
}
