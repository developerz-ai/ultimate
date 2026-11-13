// Runs snapshot-tree.sh the way the harness does — the PostToolUse JSON on stdin, in a throwaway
// git repository — and reads which refs it left. A read-only agent and a clean tree leave none;
// a writer on a dirty tree leaves one; a stale snapshot is pruned.

import { afterEach, describe, expect, test } from 'bun:test';
// why: a throwaway repository per test; Bun ships no mkdtemp.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HOOK = `${import.meta.dir}/snapshot-tree.sh`;
const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(['git', ...args], { cwd });
  return proc.stdout.toString().trim();
}

/** A repository with one commit, a writer agent and a read-only agent declared. */
async function repo(): Promise<string> {
  const root = mkdtempSync(`${tmpdir()}/snapshot-tree-`);
  roots.push(root);
  mkdirSync(`${root}/.claude/agents`, { recursive: true });
  await Bun.write(
    `${root}/.claude/agents/hunter.md`,
    '---\nname: hunter\ntools: Read, Bash\n---\n',
  );
  await Bun.write(
    `${root}/.claude/agents/builder.md`,
    '---\nname: builder\ntools: Read, Write, Edit, Bash\n---\n',
  );
  await Bun.write(`${root}/a.txt`, 'one\n');
  git(root, 'init', '-q');
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return root;
}

const refs = (root: string): readonly string[] =>
  git(root, 'for-each-ref', '--format=%(refname)', 'refs/snapshots')
    .split('\n')
    .filter((ref) => ref !== '');

/**
 * The hook backgrounds its write; poll until `done` holds (or ~2 s pass) rather than sleeping a
 * guess. A count is a weak `done` when refs already exist, so the prune test waits for the new one.
 */
async function settle(
  root: string,
  want: number | ((refs: readonly string[]) => boolean),
): Promise<readonly string[]> {
  const done = typeof want === 'number' ? (now: readonly string[]) => now.length === want : want;
  for (let i = 0; i < 40 && !done(refs(root)); i++) await Bun.sleep(50);
  return refs(root);
}

function hook(root: string, record: Record<string, unknown>, ...args: string[]): number {
  const env = { ...Bun.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t' };
  const input = JSON.stringify({ tool_name: 'Bash', cwd: root, ...record });
  const proc = Bun.spawnSync(['bash', HOOK, ...args], {
    cwd: root,
    stdin: new TextEncoder().encode(input),
    env: { ...env, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  return proc.exitCode;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('snapshot-tree.sh writes a ref only for a writer on a dirty tree', () => {
  test('the main session, tracked edit: one snapshot', async () => {
    const root = await repo();
    await Bun.write(`${root}/a.txt`, 'two\n');
    expect(hook(root, {})).toBe(0);
    expect(await settle(root, 1)).toHaveLength(1);
  });

  test('a writer subagent, tracked edit: one snapshot', async () => {
    const root = await repo();
    await Bun.write(`${root}/a.txt`, 'two\n');
    hook(root, { agent_id: 'a1', agent_type: 'builder' });
    expect(await settle(root, 1)).toHaveLength(1);
  });

  test('a read-only subagent writes no ref, even on a dirty tree', async () => {
    const root = await repo();
    await Bun.write(`${root}/a.txt`, 'two\n');
    hook(root, { agent_id: 'a1', agent_type: 'hunter' });
    expect(await settle(root, 1)).toEqual([]);
  });

  test('a built-in read-only agent type writes no ref', async () => {
    const root = await repo();
    await Bun.write(`${root}/a.txt`, 'two\n');
    hook(root, { agent_id: 'a1', agent_type: 'Explore' });
    expect(await settle(root, 1)).toEqual([]);
  });

  test('a clean tree writes no ref', async () => {
    const root = await repo();
    hook(root, {});
    expect(await settle(root, 1)).toEqual([]);
  });

  test('untracked files alone write no ref', async () => {
    const root = await repo();
    await Bun.write(`${root}/scratch.txt`, 'probe\n');
    hook(root, {});
    expect(await settle(root, 1)).toEqual([]);
  });
});

describe('snapshot-tree.sh prunes', () => {
  test('a snapshot older than 7 days goes, a 6-day-old one stays', async () => {
    const root = await repo();
    const head = git(root, 'rev-parse', 'HEAD');
    // The hook's clock, not the test's: the suite's preload may pin `Date` to a fixed day.
    const now = Number(Bun.spawnSync(['date', '+%s']).stdout.toString().trim());
    const seeded = [`refs/snapshots/${now - 8 * 86_400}`, `refs/snapshots/${now - 6 * 86_400}`];
    for (const ref of seeded) git(root, 'update-ref', ref, head);
    await Bun.write(`${root}/a.txt`, 'two\n');
    hook(root, {});
    await settle(
      root,
      (now) => now.some((ref) => !seeded.includes(ref)) && !now.includes(seeded[0] ?? ''),
    );
    // The prune loop deletes one ref per pass: give a wrong 6-day delete its moment to land.
    await Bun.sleep(300);
    const left = refs(root);
    expect(left).toHaveLength(2);
    expect(left).toContain(`refs/snapshots/${now - 6 * 86_400}`);
  });

  test('--prune deletes every snapshot', async () => {
    const root = await repo();
    git(root, 'update-ref', 'refs/snapshots/1', git(root, 'rev-parse', 'HEAD'));
    expect(hook(root, {}, '--prune')).toBe(0);
    expect(refs(root)).toEqual([]);
  });
});
