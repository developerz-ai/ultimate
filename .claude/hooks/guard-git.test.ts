// Feeds guard-destructive-git.sh the PreToolUse JSON it gets from Claude Code and pins its verdict:
// every bypass and every false block a bug hunt proved against the regex version, end to end.

import { afterAll, describe, expect, test } from 'bun:test';
// why: a throwaway directory that is another git repository; Bun ships no mkdtemp.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HOOK = `${import.meta.dir}/guard-destructive-git.sh`;
const ROOT = `${import.meta.dir}/../..`;

function run(command: string): number {
  const proc = Bun.spawnSync(['bash', HOOK], {
    stdin: new TextEncoder().encode(JSON.stringify({ tool_input: { command }, cwd: ROOT })),
    env: { ...Bun.env, CLAUDE_PROJECT_DIR: ROOT },
  });
  return proc.exitCode;
}

const BLOCKED = 2;

describe('commands that discard work are blocked', () => {
  test.each([
    ['a path', 'git checkout packages/core/src/index.ts'],
    ['a ref then -- paths', 'git checkout HEAD -- packages/core/src/index.ts'],
    ['the whole tree', 'git checkout -- .'],
    ['a double-quoted path', 'git checkout "packages/core/src/index.ts"'],
    ['a single-quoted path', "git checkout 'packages'"],
    ['-C then a relative path', 'git -C packages checkout core/src/index.ts'],
    ['cd then a relative path', 'cd packages && git checkout core'],
    ['-c before the subcommand', 'git -c core.pager=cat checkout packages'],
    ['--no-pager before the subcommand', 'git --no-pager checkout packages'],
    ['--pathspec-from-file', 'git checkout --pathspec-from-file=paths.txt'],
    ['--pathspec-from-file, separate value', 'git checkout --pathspec-from-file paths.txt'],
    [':/ pathspec magic', 'git checkout :/'],
    [':(top) pathspec magic', "git checkout ':(top)packages'"],
    ['a glob pathspec', "git checkout '*.ts'"],
    ['checkout-index', 'git checkout-index -a -f'],
    ['a snapshot ref that is not the first token', 'git checkout main packages refs/snapshots/1'],
    ['a snapshot ref only in a comment', 'git checkout main -- packages # refs/snapshots/1'],
    ['a forced checkout', 'git checkout -f main'],
    ['a forced switch', 'git switch --discard-changes main'],
    ['restore', 'git restore packages/core/src/index.ts'],
    ['restore --staged --worktree', 'git restore --staged --worktree x.ts'],
    ['reset --hard behind a global option', 'git --no-pager reset --hard'],
    ['clean', 'git clean -fd'],
    ['stash pop behind -c', 'git -c x=y stash pop'],
    ['a bare stash', 'git stash'],
    ['stash push', 'git stash push -m wip'],
    ['stash drop', 'git stash drop stash@{0}'],
    ['a checkout in a subdirectory of this checkout', `cd ${ROOT}/packages && git checkout -- .`],
    ['a second line', 'git status\ngit checkout -- packages'],
    ['env assignment prefix', 'GIT_TRACE=1 git checkout packages'],
    ['rm -r of source', 'rm -rf packages/core'],
  ])('%s', (_name, command) => {
    expect(run(command)).toBe(BLOCKED);
  });
});

describe('everyday commands pass', () => {
  test.each([
    ['a branch switch', 'git checkout main'],
    [
      'a new branch, then a test on the next line',
      'git checkout -b feat/x\nbun test ./packages/core/',
    ],
    ['a new branch named like a directory', 'git checkout -b packages'],
    ['stdout redirected', 'git checkout main > /dev/null'],
    ['stderr folded', 'git checkout main 2>&1 | tail -1'],
    ['a trailing comment naming a path', 'git checkout main # back to packages'],
    [
      'the documented snapshot restore',
      'git checkout refs/snapshots/123 -- packages/core/src/index.ts',
    ],
    ['a quoted mention', 'echo "git checkout -- ."'],
    ['a heredoc body', "cat <<'EOF' > notes.txt\ngit checkout -- .\nEOF\ngit status"],
    ['main then pull', 'git checkout main && git pull'],
    ['restore --staged', 'git restore --staged x.ts'],
    ['reset --soft', 'git reset --soft HEAD~1'],
    ['git show into a file', 'git show HEAD:a.ts > a.ts'],
    ['read-only git', 'git status && git diff --stat && git log --oneline -3'],
    ['rm -r of build output', 'rm -rf packages/core/dist node_modules/.cache/run'],
    ['no git at all', 'bun test ./packages/core/'],
    ['stash list, a read', 'git stash list'],
    ['stash show, a read', 'git -c x=y stash show -p stash@{0}'],
  ])('%s', (_name, command) => {
    expect(run(command)).toBe(0);
  });
});

// The guard protects THIS repository's uncommitted work. Another repository the session `cd`s into
// is not its business: refusing there blocked ordinary work in an unrelated checkout.
describe("commands aimed at another repository are not this guard's", () => {
  const other = mkdtempSync(`${tmpdir()}/guard-git-other-`);
  mkdirSync(`${other}/.git`);
  mkdirSync(`${other}/src`);
  afterAll(() => rmSync(other, { recursive: true, force: true }));

  test.each([
    ['cd into it', `cd ${other} && git checkout -- .`],
    ['git -C it', `git -C ${other} reset --hard`],
    ['a subdirectory of it', `cd ${other}/src && git stash`],
  ])('%s', (_name, command) => {
    expect(run(command)).toBe(0);
  });

  test('and a command that hops back into this checkout is judged again', () => {
    expect(run(`cd ${other} && git status && cd ${ROOT} && git checkout -- .`)).toBe(BLOCKED);
  });

  test('a global option that re-points git elsewhere is judged as this checkout (fail closed)', () => {
    expect(run(`cd ${other} && git --git-dir=${ROOT}/.git --work-tree=${ROOT} clean -fd`)).toBe(
      BLOCKED,
    );
  });
});
