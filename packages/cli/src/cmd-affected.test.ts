// `x affected` end to end through `affectedCommand.run`: a real workspace tree on disk read by
// `readWorkspaceGraph`, and a fake `Runner` standing in for git. The fake is the point — a real
// `git diff` here would make the verdict depend on what another agent left uncommitted in this
// checkout, which is the very failure the ref-diff default exists to avoid.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive: `mkdtemp`/`rm` build and remove the throwaway tree,
// and `join` is the host-separator path into it.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { DEFAULT_BASE } from './affected';
import { REQUIRED_BUN } from './app-root';
import { AFFECTED_MESSAGE_KEYS, affectedCommand, createAffectedCommand } from './cmd-affected';
import type { CommandContext } from './command';
import type { ExecResult, Runner } from './exec';
import { messageKeys } from './messages';
import { parseArgs } from './parse';

const TOPLEVEL = 'git rev-parse --show-toplevel';
const SYMREF = 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD';
const ORIGIN_MAIN = 'git rev-parse --verify --quiet refs/remotes/origin/main^{commit}';
const VERIFY = `git rev-parse --verify --quiet ${DEFAULT_BASE}^{commit}`;
const BASE_DIFF = `git diff --name-only -z ${DEFAULT_BASE}...HEAD`;
const TREE_DIFF = 'git diff --name-only -z HEAD';
const UNTRACKED = 'git ls-files -z --others --exclude-standard';

/** A → B → C across three real package.json files, so the graph under test is the one
 *  `readWorkspaceGraph` produces rather than a hand-written stand-in for it. */
async function chainRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ultimate-x-affected-'));
  await Bun.write(
    join(root, 'package.json'),
    JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
  );
  await Bun.write(
    join(root, 'packages/a/package.json'),
    JSON.stringify({ name: '@x/a', version: '1.0.0', dependencies: { '@x/b': 'workspace:*' } }),
  );
  await Bun.write(
    join(root, 'packages/b/package.json'),
    JSON.stringify({ name: '@x/b', version: '1.0.0', dependencies: { '@x/c': 'workspace:*' } }),
  );
  await Bun.write(
    join(root, 'packages/c/package.json'),
    JSON.stringify({ name: '@x/c', version: '1.0.0' }),
  );
  return root;
}

interface Recorder {
  readonly calls: readonly (readonly string[])[];
  readonly runner: Runner;
}

const recorder = (replies: Readonly<Record<string, string>>): Recorder => {
  const calls: (readonly string[])[] = [];
  const runner: Runner = async (command): Promise<ExecResult> => {
    calls.push(command);
    const stdout = replies[command.join(' ')];
    return {
      command,
      code: stdout === undefined ? 1 : 0,
      ok: stdout !== undefined,
      stdout: stdout ?? '',
      stderr: '',
      durationMs: 1,
    };
  };
  return { calls, runner };
};

/** Scoped to this command's own spec, never the full registry: these tests must not depend on a
 *  concurrent worker's in-progress `registry.ts`. */
const context = (argv: readonly string[], cwd: string, runner: Runner): CommandContext => ({
  args: parseArgs(argv, [affectedCommand.spec]),
  cwd,
  runner,
  env: {},
  bunVersion: REQUIRED_BUN,
});

interface AffectedData {
  readonly base: string;
  readonly dirty: boolean;
  readonly root: string;
  readonly changed: readonly string[];
  readonly ignored: readonly string[];
  readonly rootWide: readonly string[];
  readonly paths: readonly string[];
  readonly workspaces: readonly { readonly name: string; readonly dir: string }[];
}

const dataOf = (result: { readonly data?: unknown }): AffectedData => result.data as AffectedData;

async function withRepo(
  run: (root: string) => Promise<void>,
  build: () => Promise<string> = chainRepo,
): Promise<void> {
  const root = await build();
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('unit · x affected answers over the real workspace graph', () => {
  test('a change two edges down reaches every dependent above it', async () => {
    await withRepo(async (root) => {
      const { runner } = recorder({
        [TOPLEVEL]: `${root}\n`,
        [VERIFY]: 'abc\n',
        [BASE_DIFF]: 'packages/c/src/index.ts\0',
      });
      const result = await affectedCommand.run(context(['affected'], root, runner));
      expect(result.ok).toBe(true);
      expect(dataOf(result).workspaces.map((workspace) => workspace.name)).toEqual([
        '@x/a',
        '@x/b',
        '@x/c',
      ]);
      expect(dataOf(result).paths).toEqual(['packages/a', 'packages/b', 'packages/c']);
    });
  });

  test('the JSON carries the diff it was asked for, so an empty answer explains itself', async () => {
    await withRepo(async (root) => {
      const { runner } = recorder({
        [TOPLEVEL]: `${root}\n`,
        [VERIFY]: 'abc\n',
        [BASE_DIFF]: 'docs/plan.md\0',
      });
      const result = await affectedCommand.run(context(['affected'], root, runner));
      // Green, and it says why: a doc re-checks nothing, and reporting it red would fail a build
      // for editing a plan.
      expect(result.ok).toBe(true);
      expect(dataOf(result)).toMatchObject({
        base: DEFAULT_BASE,
        dirty: false,
        changed: ['docs/plan.md'],
        ignored: ['docs/plan.md'],
        rootWide: [],
        workspaces: [],
        paths: [],
      });
      expect(result.lines ?? []).toEqual([]);
    });
  });

  test('a root file returns every workspace, and the human output names the file', async () => {
    await withRepo(async (root) => {
      const { runner } = recorder({
        [TOPLEVEL]: `${root}\n`,
        [VERIFY]: 'abc\n',
        [BASE_DIFF]: 'tsconfig.json\0',
      });
      const result = await affectedCommand.run(context(['affected'], root, runner));
      expect(dataOf(result).paths).toHaveLength(3);
      expect(dataOf(result).rootWide).toEqual(['tsconfig.json']);
      // The note, then the header, then one row per workspace. Counted rather than matched on the
      // prose, so this test stays about the projection and not about the catalog.
      expect(result.lines).toHaveLength(5);
    });
  });
});

describe('unit · x affected diffs a ref, and only reads the tree when told to', () => {
  // The design decision, pinned: several agents share one checkout here, so a working-tree diff by
  // default would return every one of their uncommitted files and the set would stop narrowing.
  test('the default run spawns no working-tree read at all', async () => {
    await withRepo(async (root) => {
      const { calls, runner } = recorder({
        [TOPLEVEL]: `${root}\n`,
        [VERIFY]: 'abc\n',
        [BASE_DIFF]: 'packages/a/src/x.ts\0',
      });
      await affectedCommand.run(context(['affected'], root, runner));
      const spawned = calls.map((call) => call.join(' '));
      // No remote in this fake: both default-base probes miss, and local `main` is the fallback.
      expect(spawned).toEqual([TOPLEVEL, SYMREF, ORIGIN_MAIN, VERIFY, BASE_DIFF]);
      expect(spawned).not.toContain(TREE_DIFF);
      expect(spawned).not.toContain(UNTRACKED);
    });
  });

  test('--dirty adds the tracked edits and the untracked files, and says so in the output', async () => {
    await withRepo(async (root) => {
      const { calls, runner } = recorder({
        [TOPLEVEL]: `${root}\n`,
        [VERIFY]: 'abc\n',
        [BASE_DIFF]: '',
        [TREE_DIFF]: 'packages/c/src/x.ts\0',
        [UNTRACKED]: '',
      });
      const result = await affectedCommand.run(context(['affected', '--dirty'], root, runner));
      expect(calls.map((call) => call.join(' '))).toEqual([
        TOPLEVEL,
        SYMREF,
        ORIGIN_MAIN,
        VERIFY,
        BASE_DIFF,
        TREE_DIFF,
        UNTRACKED,
      ]);
      expect(dataOf(result).dirty).toBe(true);
      expect(dataOf(result).paths).toHaveLength(3);
    });
  });

  test('the graph is read from the checkout root, not from the directory the command ran in', async () => {
    await withRepo(async (root) => {
      const { calls, runner } = recorder({
        [TOPLEVEL]: `${root}\n`,
        [VERIFY]: 'abc\n',
        [BASE_DIFF]: 'packages/c/src/x.ts\0',
      });
      const result = await affectedCommand.run(
        context(['affected'], join(root, 'packages', 'a', 'src'), runner),
      );
      // The diff itself must be taken at the root too, or git's paths would come back relative to
      // the subdirectory and match no workspace dir.
      expect(calls.slice(1).every((call) => call[0] === 'git')).toBe(true);
      expect(dataOf(result).root).toBe(root);
      expect(dataOf(result).paths).toHaveLength(3);
    });
  });
});

describe('unit · x affected measures against the remote-tracking default branch', () => {
  // A checkout nobody pulls (or a worktree) has a stale local `main`: diffed against it, the
  // answer counts files origin already merged as this branch's work.
  test('origin/HEAD decides the base, and --json says which base was used', async () => {
    await withRepo(async (root) => {
      const { calls, runner } = recorder({
        [TOPLEVEL]: `${root}\n`,
        [SYMREF]: 'origin/main\n',
        'git rev-parse --verify --quiet origin/main^{commit}': 'abc\n',
        'git diff --name-only -z origin/main...HEAD': 'packages/c/src/x.ts\0',
      });
      const result = await affectedCommand.run(context(['affected'], root, runner));
      expect(dataOf(result).base).toBe('origin/main');
      expect(calls.map((call) => call.join(' '))).not.toContain(BASE_DIFF);
      expect(dataOf(result).paths).toHaveLength(3);
    });
  });

  test('--base still overrides, and asks git nothing about the default', async () => {
    await withRepo(async (root) => {
      const { calls, runner } = recorder({
        [TOPLEVEL]: `${root}\n`,
        'git rev-parse --verify --quiet next^{commit}': 'abc\n',
        'git diff --name-only -z next...HEAD': '',
      });
      const result = await affectedCommand.run(
        context(['affected', '--base', 'next'], root, runner),
      );
      expect(dataOf(result).base).toBe('next');
      expect(calls.map((call) => call.join(' '))).not.toContain(SYMREF);
    });
  });
});

describe('unit · x affected --paths', () => {
  // `bun test $(x affected --paths)` is the use the help promises: every byte on stdout is an
  // argument to the next command, so a note or the `✓` summary there is a bogus path.
  test('--paths writes only the directories to stdout; notes and the summary go to stderr', async () => {
    await withRepo(async (root) => {
      const replies = {
        [TOPLEVEL]: `${root}\n`,
        [VERIFY]: 'abc\n',
        // A root file: the run that also carries a note line, which must not reach stdout.
        [BASE_DIFF]: 'tsconfig.json\0',
      };
      const stdout: string[] = [];
      const command = createAffectedCommand((line) => stdout.push(line));
      const result = await command.run(
        context(['affected', '--paths'], root, recorder(replies).runner),
      );
      expect(stdout).toEqual(['packages/a', 'packages/b', 'packages/c']);
      // Every stdout line parses as a path, and names a directory that exists.
      for (const line of stdout) {
        expect(line).toMatch(/^[\w@./-]+$/);
        expect(await Bun.file(join(root, line, 'package.json')).exists()).toBe(true);
      }
      // The rest of the render — the root-wide note and the summary — is fd 2's.
      expect(result.stream).toBe('stderr');
      expect(result.lines).toHaveLength(1);
      expect(result.lines).not.toContain('packages/a');
      const table = await command.run(context(['affected'], root, recorder(replies).runner));
      // Same data either way: a flag that changed `--json` would be a second answer to one question.
      expect(dataOf(result)).toEqual(dataOf(table));
      expect(table.stream).toBeUndefined();
    });
  });

  test('--paths with nothing affected writes nothing to stdout', async () => {
    await withRepo(async (root) => {
      const replies = { [TOPLEVEL]: `${root}\n`, [VERIFY]: 'abc\n', [BASE_DIFF]: 'a.md\0' };
      const stdout: string[] = [];
      const result = await createAffectedCommand((line) => stdout.push(line)).run(
        context(['affected', '--paths'], root, recorder(replies).runner),
      );
      expect(stdout).toEqual([]);
      expect(result.stream).toBe('stderr');
    });
  });

  test('--paths under --json leaves stdout to the one document', async () => {
    await withRepo(async (root) => {
      const replies = {
        [TOPLEVEL]: `${root}\n`,
        [VERIFY]: 'abc\n',
        [BASE_DIFF]: 'packages/a/src/x.ts\0',
      };
      const stdout: string[] = [];
      const result = await createAffectedCommand((line) => stdout.push(line)).run(
        context(['affected', '--paths', '--json'], root, recorder(replies).runner),
      );
      expect(stdout).toEqual([]);
      expect(result.stream).toBeUndefined();
      expect(dataOf(result).paths).toEqual(['packages/a']);
    });
  });

  test('the spec declares every flag the usage line promises', () => {
    const names = (affectedCommand.spec.flags ?? []).map((flag) => flag.name);
    expect(names).toEqual(['base', 'dirty', 'paths']);
    for (const flag of names) expect(affectedCommand.spec.usage).toContain(`--${flag}`);
  });
});

describe('unit · x affected renders no missing catalog key', () => {
  // `msg()` answers `⟦key⟧` for a key the catalog lacks — loud in the terminal, and completely
  // invisible to a build. This is the rule that makes it visible before a release.
  test('every key cmd-affected.ts renders exists in messages.ts', () => {
    const catalog = new Set(messageKeys());
    const missing = AFFECTED_MESSAGE_KEYS.filter((key) => !catalog.has(key));
    expect(missing).toEqual([]);
  });
});
