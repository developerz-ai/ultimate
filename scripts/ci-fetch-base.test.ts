// `.github/actions/fetch-base`, RUN: its script against a real pull-request checkout. The shape
// test pins where the action is used; this one proves what it fetches. A depth-1 clone of a merge
// commit whose base main has since moved on must answer `origin/main` = the merge commit's FIRST
// parent (#1328: main's moving tip put another PR's files in this run's diff), and any other event
// keeps main's tip.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path'; // why: Bun ships no path API.
import { type TempTree, tempTree } from '@ultimat3/testing';
import { repoRoot } from './lib/run';

interface Action {
  readonly runs?: { readonly steps?: readonly { readonly run?: string }[] };
}

const script = async (): Promise<string> => {
  const path = `${repoRoot()}/.github/actions/fetch-base/action.yml`;
  const action = Bun.YAML.parse(await Bun.file(path).text()) as Action;
  return action.runs?.steps?.[0]?.run ?? expect.unreachable('fetch-base has one run step');
};

/** git in `cwd`, failing the test with git's own words on a non-zero exit. */
const git = async (tree: TempTree, cwd: string, args: readonly string[]): Promise<string> => {
  const done = await tree.git(args, { cwd });
  expect([args.join(' '), done.code, done.stderr]).toEqual([args.join(' '), 0, done.stderr]);
  return done.stdout.trim();
};

const commit = async (tree: TempTree, cwd: string, file: string): Promise<string> => {
  await Bun.write(join(cwd, file), file);
  await git(tree, cwd, ['add', file]);
  await git(tree, cwd, ['commit', '-q', '-m', file]);
  return git(tree, cwd, ['rev-parse', 'HEAD']);
};

/**
 * origin: main at `base`, a branch off it, the merge commit GitHub would build (first parent
 * `base`) on `refs/pull/1/merge`, then main moved on past `base`. The checkout is a depth-1 clone
 * of that merge commit, as actions/checkout makes one for a pull_request run.
 */
async function pullRequestCheckout(tree: TempTree) {
  const origin = join(tree.path, 'origin');
  await git(tree, tree.path, ['init', '-q', '-b', 'main', origin]);
  await git(tree, origin, ['config', 'uploadpack.allowReachableSHA1InWant', 'true']);
  const base = await commit(tree, origin, 'base.txt');
  await git(tree, origin, ['checkout', '-q', '-b', 'topic']);
  await commit(tree, origin, 'topic.txt');
  await git(tree, origin, ['checkout', '-q', '--detach', base]);
  await git(tree, origin, ['merge', '-q', '--no-ff', '-m', 'merge', 'topic']);
  const merge = await git(tree, origin, ['rev-parse', 'HEAD']);
  await git(tree, origin, ['update-ref', 'refs/pull/1/merge', merge]);
  await git(tree, origin, ['checkout', '-q', 'main']);
  const moved = await commit(tree, origin, 'another-pr.txt');
  const work = join(tree.path, 'work');
  await git(tree, tree.path, ['init', '-q', work]);
  await git(tree, work, ['remote', 'add', 'origin', `file://${origin}`]);
  await git(tree, work, ['fetch', '-q', '--depth=1', 'origin', merge]);
  await git(tree, work, ['checkout', '-q', '--detach', merge]);
  return { work, base, moved };
}

const runAction = async (tree: TempTree, cwd: string, event: string): Promise<void> => {
  const child = tree.spawn(['bash', '-e', '-o', 'pipefail', '-c', await script()], {
    cwd,
    env: { ...tree.gitEnv, GITHUB_EVENT_NAME: event },
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect([code, stderr]).toEqual([0, stderr]);
};

describe('unit · fetch-base pins origin/main to the run base', () => {
  test("a pull_request run reads its merge commit's first parent, not main's moved tip", async () => {
    await using tree = tempTree('fetch-base-');
    const { work, base, moved } = await pullRequestCheckout(tree);
    await runAction(tree, work, 'pull_request');
    const fetched = await git(tree, work, ['rev-parse', 'refs/remotes/origin/main']);
    expect(fetched).toBe(base);
    expect(fetched).not.toBe(moved);
  });

  test("any other event reads main's tip", async () => {
    await using tree = tempTree('fetch-base-');
    const { work, moved } = await pullRequestCheckout(tree);
    await runAction(tree, work, 'push');
    expect(await git(tree, work, ['rev-parse', 'refs/remotes/origin/main'])).toBe(moved);
  });
});
