// `x affected` end to end through `affectedCommand.run`: a real workspace tree on disk read by
// `readWorkspaceGraph`, and a fake `Runner` standing in for git. The fake is the point — a real
// `git diff` here would make the verdict depend on what another agent left uncommitted in this
// checkout, which is the very failure the ref-diff default exists to avoid.

import { describe, expect, test } from 'bun:test';
// Bun ships no temp-directory primitive: `mkdtemp`/`rm` build and remove the throwaway tree, and
// `join` is the host-separator path into it.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BASE } from './affected';
import { AFFECTED_MESSAGE_KEYS, affectedCommand } from './cmd-affected';
import type { CommandContext } from './command';
import type { ExecResult, Runner } from './exec';
import { messageKeys } from './messages';
import { parseArgs } from './parse';

const TOPLEVEL = 'git rev-parse --show-toplevel';
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
  bunVersion: '1.3.0',
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
      expect(spawned).toEqual([TOPLEVEL, VERIFY, BASE_DIFF]);
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

describe('unit · x affected --paths', () => {
  test('--paths prints bare directories while --json keeps both projections', async () => {
    await withRepo(async (root) => {
      const replies = {
        [TOPLEVEL]: `${root}\n`,
        [VERIFY]: 'abc\n',
        [BASE_DIFF]: 'packages/a/src/x.ts\0',
      };
      const table = await affectedCommand.run(
        context(['affected'], root, recorder(replies).runner),
      );
      const paths = await affectedCommand.run(
        context(['affected', '--paths'], root, recorder(replies).runner),
      );
      expect(paths.lines).toEqual(['packages/a']);
      // The table form names the workspace as well, so the two renderings are not the same list.
      expect((table.lines ?? []).join('\n')).toContain('@x/a');
      expect(table.lines).not.toEqual(paths.lines);
      // Same data either way: a flag that changed `--json` would be a second answer to one question.
      expect(dataOf(paths)).toEqual(dataOf(table));
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
