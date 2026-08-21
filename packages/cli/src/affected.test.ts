// The two halves of `x affected`, held apart: the closure over a hand-built graph (no git, no
// checkout — the verdict must not depend on what another agent left uncommitted in this tree), and
// the git reader driven through a fake `Runner` that records the argv it was asked to spawn.

import { describe, expect, test } from 'bun:test';
import {
  changedFiles,
  DEFAULT_BASE,
  gitRoot,
  owningWorkspace,
  planAffected,
  ROOT_WIDE_FILES,
  readAffectedSelection,
} from './affected';
import type { ExecResult, Runner } from './exec';
import type { CommandSpec } from './parse';
import { parseArgs } from './parse';
import type { WorkspaceNode } from './workspace-graph';

const node = (name: string, dir: string, dependencies: readonly string[] = []): WorkspaceNode => ({
  name,
  dir,
  dependencies,
});

/** A → B → C, declared out of dependency order on purpose: a one-pass sweep must not be rescued
 *  by the list happening to be sorted leaf-first. */
const CHAIN: readonly WorkspaceNode[] = [
  node('@x/a', 'packages/a', ['@x/b']),
  node('@x/c', 'packages/c'),
  node('@x/b', 'packages/b', ['@x/c']),
];

const names = (plan: { readonly workspaces: readonly WorkspaceNode[] }): readonly string[] =>
  plan.workspaces.map((workspace) => workspace.name);

describe('unit · affected closes over the graph transitively', () => {
  // The stated failure mode of the issue: `A → B → C`, a change in C, and an implementation that
  // walks the dependents once answers `{ C, B }` — 2 — while A is broken and untested.
  test('a change in C reaches A, two edges away', () => {
    const plan = planAffected(CHAIN, ['packages/c/src/index.ts']);
    expect(names(plan)).toEqual(['@x/a', '@x/b', '@x/c']);
    expect(plan.workspaces).toHaveLength(3);
  });

  test('a change in the leaf-most dependent reaches only itself', () => {
    expect(names(planAffected(CHAIN, ['packages/a/src/index.ts']))).toEqual(['@x/a']);
  });

  test('a dependency cycle terminates instead of walking forever', () => {
    const cyclic = [
      node('@x/one', 'packages/one', ['@x/two']),
      node('@x/two', 'packages/two', ['@x/one']),
    ];
    expect(names(planAffected(cyclic, ['packages/one/src/a.ts']))).toEqual(['@x/one', '@x/two']);
  });

  test('a file under no workspace at all affects nothing', () => {
    const plan = planAffected(CHAIN, ['scripts/bench/run.ts']);
    expect(plan.workspaces).toEqual([]);
    expect(plan.rootWide).toEqual([]);
  });
});

describe('unit · affected maps a path to the workspace that owns it', () => {
  test('the longest matching directory wins, so a nested workspace keeps its own files', () => {
    // The outer workspace is declared FIRST, so an implementation that takes the first match
    // instead of the longest one answers `@x/root` for both paths.
    const nested = [node('@x/root', 'apps'), node('@x/app', 'apps/web')];
    expect(owningWorkspace(nested, 'apps/web/site/page.tsx')?.name).toBe('@x/app');
    expect(owningWorkspace(nested, 'apps/tooling/x.ts')?.name).toBe('@x/root');
  });

  // `packages/ab` must not swallow `packages/abc`: a prefix test without the separator would.
  test('a sibling whose directory is a string prefix is not matched', () => {
    const siblings = [node('@x/ab', 'packages/ab'), node('@x/abc', 'packages/abc')];
    expect(owningWorkspace(siblings, 'packages/abc/src/x.ts')?.name).toBe('@x/abc');
  });
});

describe('unit · a root file means every workspace', () => {
  test.each(['tsconfig.json', 'biome.json', 'package.json', 'app.config.ts'])(
    '%s is root-wide, so a scoped run can never skip a package it just broke',
    (path) => {
      const plan = planAffected(CHAIN, [path]);
      expect(names(plan)).toEqual(['@x/a', '@x/b', '@x/c']);
      expect(plan.rootWide).toEqual([path]);
    },
  );

  // The whole path is matched, never the basename: a workspace's own manifest is that workspace's
  // change, and reading it as root-wide would make every package.json edit run the entire repo.
  test("a workspace's own package.json is that workspace's change, not the root's", () => {
    const plan = planAffected(CHAIN, ['packages/c/package.json']);
    expect(plan.rootWide).toEqual([]);
    expect(names(plan)).toEqual(['@x/a', '@x/b', '@x/c']);
    expect(names(planAffected(CHAIN, ['packages/a/package.json']))).toEqual(['@x/a']);
  });

  test('every declared root-wide file is a root-level path, never a directory', () => {
    for (const path of ROOT_WIDE_FILES) expect(path.includes('/')).toBe(false);
  });
});

describe('unit · a doc affects nothing', () => {
  test('a .md-only diff returns an empty set and says which files it ignored', () => {
    const plan = planAffected(CHAIN, ['docs/idea/14-roadmap.md', 'README.md']);
    expect(plan.workspaces).toEqual([]);
    expect(plan.ignored).toEqual(['docs/idea/14-roadmap.md', 'README.md']);
  });

  // The doc rule beats the directory rule: a README inside a package is still nothing to compile.
  test('a .md inside a workspace does not select that workspace', () => {
    expect(planAffected(CHAIN, ['packages/c/README.md']).workspaces).toEqual([]);
  });

  test('a .md alongside a source file does not suppress the source file', () => {
    const plan = planAffected(CHAIN, ['packages/a/README.md', 'packages/a/src/x.ts']);
    expect(names(plan)).toEqual(['@x/a']);
    expect(plan.changed).toEqual(['packages/a/README.md', 'packages/a/src/x.ts']);
  });
});

interface Recorder {
  readonly calls: readonly (readonly string[])[];
  readonly runner: Runner;
}

/** Answers each git invocation from a table keyed by the argv it receives; anything not in the
 *  table exits 1, so a call this test did not anticipate fails loudly instead of reading empty. */
const recorder = (replies: Readonly<Record<string, string>>): Recorder => {
  const calls: (readonly string[])[] = [];
  const runner: Runner = async (command): Promise<ExecResult> => {
    calls.push(command);
    const key = command.join(' ');
    const stdout = replies[key];
    return {
      command,
      code: stdout === undefined ? 1 : 0,
      ok: stdout !== undefined,
      stdout: stdout ?? '',
      stderr: stdout === undefined ? `fatal: unexpected: ${key}` : '',
      durationMs: 1,
    };
  };
  return { calls, runner };
};

const VERIFY = `git rev-parse --verify --quiet ${DEFAULT_BASE}^{commit}`;
const BASE_DIFF = `git diff --name-only -z ${DEFAULT_BASE}...HEAD`;
const TREE_DIFF = 'git diff --name-only -z HEAD';
const UNTRACKED = 'git ls-files -z --others --exclude-standard';

describe('unit · affected reads its diff from a ref, not from the working tree', () => {
  test('the default diff is <base>...HEAD and nothing else is spawned', async () => {
    const { calls, runner } = recorder({
      [VERIFY]: 'abc123\n',
      [BASE_DIFF]: 'packages/a/src/x.ts\0packages/b/src/y.ts\0',
    });
    const files = await changedFiles(runner, {
      cwd: '/repo',
      command: 'affected',
      selection: { base: DEFAULT_BASE, dirty: false },
    });
    expect(files).toEqual(['packages/a/src/x.ts', 'packages/b/src/y.ts']);
    expect(calls.map((call) => call.join(' '))).toEqual([VERIFY, BASE_DIFF]);
  });

  // Three dots, never two: a two-dot diff reports every commit merged into `main` since this
  // branch forked as this branch's own work, and the affected set becomes the whole repo.
  test('the diff is a merge-base diff', async () => {
    const { calls, runner } = recorder({ [VERIFY]: 'abc123\n', [BASE_DIFF]: '' });
    await changedFiles(runner, {
      cwd: '/repo',
      command: 'affected',
      selection: { base: DEFAULT_BASE, dirty: false },
    });
    expect(calls[1]?.at(-1)).toBe(`${DEFAULT_BASE}...HEAD`);
  });

  test('--dirty unions the tracked edits and the untracked files on top', async () => {
    const { calls, runner } = recorder({
      [VERIFY]: 'abc123\n',
      [BASE_DIFF]: 'packages/a/src/x.ts\0',
      [TREE_DIFF]: 'packages/a/src/x.ts\0packages/b/src/y.ts\0',
      [UNTRACKED]: 'packages/c/src/new.ts\0',
    });
    const files = await changedFiles(runner, {
      cwd: '/repo',
      command: 'affected',
      selection: { base: DEFAULT_BASE, dirty: true },
    });
    // Deduped and sorted, so two git calls naming one file report it once.
    expect(files).toEqual(['packages/a/src/x.ts', 'packages/b/src/y.ts', 'packages/c/src/new.ts']);
    expect(calls.map((call) => call.join(' '))).toEqual([VERIFY, BASE_DIFF, TREE_DIFF, UNTRACKED]);
  });

  test('paths are read NUL-delimited, so a name holding a space survives', async () => {
    const { runner } = recorder({
      [VERIFY]: 'abc123\n',
      [BASE_DIFF]: 'packages/a/src/two words.ts\0packages/a/src/b.ts\0',
    });
    const files = await changedFiles(runner, {
      cwd: '/repo',
      command: 'affected',
      selection: { base: DEFAULT_BASE, dirty: false },
    });
    expect(files).toContain('packages/a/src/two words.ts');
    expect(files).toHaveLength(2);
  });

  test('a base git cannot resolve is refused before any diff runs, with a fetch to paste', async () => {
    const { calls, runner } = recorder({});
    await expect(
      changedFiles(runner, {
        cwd: '/repo',
        command: 'affected',
        selection: { base: 'origin/nope', dirty: false },
      }),
    ).rejects.toMatchObject({
      code: 'X_CLI_BAD_FLAG',
      fix: 'git fetch --no-tags origin origin/nope:origin/nope, then re-run: x affected --base origin/nope --json',
    });
    expect(calls).toHaveLength(1);
  });

  test('a git call that fails for any other reason carries git’s own output', async () => {
    const { runner } = recorder({ [VERIFY]: 'abc123\n' });
    await expect(
      changedFiles(runner, {
        cwd: '/repo',
        command: 'affected',
        selection: { base: DEFAULT_BASE, dirty: false },
      }),
    ).rejects.toMatchObject({
      code: 'X_CLI_UNEXPECTED',
      fix: `run it yourself to see why: ${BASE_DIFF}`,
    });
  });
});

describe('unit · affected resolves the checkout root git reports paths against', () => {
  test('the toplevel is trimmed of its newline', async () => {
    const { runner } = recorder({ 'git rev-parse --show-toplevel': '/home/me/repo\n' });
    expect(await gitRoot(runner, '/home/me/repo/packages/cli', 'affected')).toBe('/home/me/repo');
  });

  test('outside a checkout it refuses with a command that proves the diagnosis', async () => {
    const { runner } = recorder({});
    await expect(gitRoot(runner, '/tmp/nowhere', 'affected')).rejects.toMatchObject({
      code: 'X_CLI_UNEXPECTED',
      fix: 'run x affected from inside a git checkout — confirm with: git rev-parse --show-toplevel',
    });
  });
});

const SPEC: CommandSpec = {
  name: 'affected',
  summary: 'test spec',
  usage: 'x affected',
  flags: [
    { name: 'base', type: 'string', summary: 'ref' },
    { name: 'dirty', type: 'boolean', summary: 'working tree' },
  ],
};

const selection = (argv: readonly string[]) =>
  readAffectedSelection(parseArgs(argv, [SPEC]), 'affected');

describe('unit · the --base/--dirty reader is one reader for both commands', () => {
  test('the default is the merge-base with the default branch, and the tree is not read', () => {
    expect(selection(['affected'])).toEqual({ base: DEFAULT_BASE, dirty: false });
  });

  test('--dirty is opt-in, because this checkout holds several agents at once', () => {
    expect(selection(['affected', '--dirty'])).toEqual({ base: DEFAULT_BASE, dirty: true });
  });

  test('--base takes the ref verbatim', () => {
    expect(selection(['affected', '--base', 'origin/main']).base).toBe('origin/main');
  });

  // `x test --base main` is refused by `x test` itself — the flag narrows nothing without
  // `--affected` — so a fix line that dropped it would reproduce its own failure, verbatim.
  test('a fix line re-runs the caller’s own invocation, never one that command refuses', async () => {
    const { runner } = recorder({});
    await expect(
      changedFiles(runner, {
        cwd: '/repo',
        command: 'test',
        selection: { base: DEFAULT_BASE, dirty: false },
      }),
    ).rejects.toMatchObject({
      fix: `git fetch --no-tags origin ${DEFAULT_BASE}:${DEFAULT_BASE}, then re-run: x test --affected --base ${DEFAULT_BASE} --json`,
    });
    expect(() =>
      readAffectedSelection(parseArgs(['affected', '--base', ' '], [SPEC]), 'test'),
    ).toThrowError(
      expect.objectContaining({ fix: `x test --affected --base ${DEFAULT_BASE} --json` }),
    );
  });

  test('an empty --base is refused rather than silently becoming the default', () => {
    expect(() => selection(['affected', '--base', '   '])).toThrowError(
      expect.objectContaining({ code: 'X_CLI_BAD_FLAG' }),
    );
  });
});
