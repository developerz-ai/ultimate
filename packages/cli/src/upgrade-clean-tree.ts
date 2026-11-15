// `x upgrade`'s first refusal: a hop is one reviewable commit, so the tree must be clean — its own
// lock and record aside. When a stopped hop's record is there, the dirty tree IS that hop, and the
// fix is to stash it: committing half a hop is how a broken tree gets reviewed as a finished one.

// why: Bun exposes no path-join primitive; the state files are joined onto the app root.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import type { Runner } from './exec';
import { posixRelative } from './posix-path';
import { UPGRADE_LOCK_FILE } from './upgrade-lock';
import type { UnfinishedHop } from './upgrade-unfinished';
import { UNFINISHED_FILE } from './upgrade-unfinished';

/** The repository's root, or the refusal: git is the only record of where the walk stands. */
export async function requireCleanTree(
  runner: Runner,
  root: string,
  unfinished: UnfinishedHop | undefined,
): Promise<string> {
  const top = await runner(['git', 'rev-parse', '--show-toplevel'], { cwd: root });
  if (!top.ok) {
    throw new UltimateError({
      code: 'X_UPGRADE_DIRTY_TREE',
      cause: `${root} is not a git repository, and a hop has to be one commit you can review or undo`,
      fix: 'git init && git add -A && git commit -m "before x upgrade"   # then: x upgrade --json',
    });
  }
  const repo = top.stdout.trim();
  // Every untracked file by name, so this run's own lock and record — in an `.x/` a repository
  // with no app may not ignore — are told apart from an author's change.
  const own = new Set(
    [UPGRADE_LOCK_FILE, UNFINISHED_FILE].map((file) => posixRelative(repo, join(root, file))),
  );
  const status = await runner(['git', 'status', '--porcelain', '--untracked-files=all'], {
    cwd: root,
  });
  const changes = status.stdout
    .split('\n')
    .filter((line) => line.trim().length > 0 && !own.has(line.slice(3)));
  if (status.ok && changes.length === 0) return repo;
  const listed = changes.slice(0, 5).join('; ');
  if (unfinished !== undefined) {
    throw new UltimateError({
      code: 'X_UPGRADE_DIRTY_TREE',
      cause: `an x upgrade from ${unfinished.from} to ${unfinished.to} stopped after writing its pins (${UNFINISHED_FILE}, started ${unfinished.startedAt || 'at an unknown time'}), and its ${String(changes.length)} uncommitted change(s) are that half-finished hop: ${listed}`,
      fix: 'git stash push --include-untracked   # sets the half hop aside; then: x upgrade --json',
    });
  }
  throw new UltimateError({
    code: 'X_UPGRADE_DIRTY_TREE',
    cause: `${String(changes.length)} uncommitted change(s), and a hop has to be one reviewable commit: ${listed}`,
    fix: 'git status --short   # then commit or stash, and re-run: x upgrade --json',
  });
}
