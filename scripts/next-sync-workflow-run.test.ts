// `.github/workflows/next-sync.yml`'s two shell steps, RUN: each step's real `run:` script under
// bash against a throwaway origin and a `gh` stub on PATH. A clean merge reaches `next` and
// dispatches ci.yml; a conflict pushes nothing and names its files; the report files one issue,
// comments on its twin, and closes it on a clean week. The shape test holds the text; this, the act.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmod } from 'node:fs/promises'; // why: Bun has no chmod.
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { TEMP_TREE_GIT_ENV, tempTrees } from '../packages/testing/src/temp-tree';
import { readWorkflow } from './lib/ci-workflow-read';
import { REPO_SCAN_TIMEOUT_MS, run } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const trees = tempTrees();
afterAll(() => trees.dispose());
/** Every child here may run git: the temp tree's environment, so no hook's GIT_* leaks in. */
const gitEnv = (): Record<string, string | undefined> => ({ ...Bun.env, ...TEMP_TREE_GIT_ENV });
let steps = 0;
const TREE_CONFIG = Number(TEMP_TREE_GIT_ENV['GIT_CONFIG_COUNT'] ?? '0');

const workflow = await readWorkflow('next-sync.yml');
const script = (job: string): string => workflow.jobs?.[job]?.steps?.find((s) => s.run)?.run ?? '';
const REPO = 'owner/repo';
const PUSH_URL = `https://x-access-token:tok@github.com/${REPO}.git`;

async function scratch(): Promise<string> {
  return trees.make('next-sync-');
}

/** A `gh` that appends its argv to `calls` and answers `issue list` with `$GH_ISSUES`. */
async function ghStub(dir: string): Promise<string> {
  const bin = join(dir, 'bin');
  await Bun.write(
    join(bin, 'gh'),
    '#!/usr/bin/env bash\necho "$*" >> "$GH_CALLS"\nif [ "$1 $2" = "issue list" ]; then echo "$GH_ISSUES"; fi\n',
  );
  await chmod(join(bin, 'gh'), 0o755);
  return bin;
}

const bash = async (body: string, cwd: string, env: Record<string, string>) => {
  steps += 1;
  const file = join(cwd, '..', `step-${steps}.sh`);
  await Bun.write(file, body);
  return run(['bash', file], { cwd, env: { ...gitEnv(), ...env } });
};

/** origin (bare) with `main` and `next`, and a clone of it standing in for the checkout. */
async function repos(conflict: boolean) {
  const dir = await scratch();
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  const g = async (cwd: string, ...args: string[]) => {
    const out = await run(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd,
      env: gitEnv(),
    });
    expect({ args, ok: out.ok, output: out.output }).toMatchObject({ args, ok: true });
    return out.output.trim();
  };
  await g(dir, 'init', '--quiet', '--bare', '-b', 'main', origin);
  await g(dir, 'clone', '--quiet', origin, work);
  await Bun.write(join(work, 'a.txt'), 'one\n');
  await g(work, 'add', '-A');
  await g(work, 'commit', '--quiet', '-m', 'one');
  await g(work, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main', 'HEAD:refs/heads/next');
  await g(work, 'switch', '--quiet', '-c', 'side', 'origin/main');
  await Bun.write(join(work, 'a.txt'), conflict ? 'next\n' : 'one\n');
  await Bun.write(join(work, 'b.txt'), 'a break\n');
  await g(work, 'add', '-A');
  await g(work, 'commit', '--quiet', '-m', 'a break');
  await g(work, 'push', '--quiet', 'origin', 'HEAD:refs/heads/next');
  await g(work, 'switch', '--quiet', 'main');
  await Bun.write(join(work, 'a.txt'), 'main\n');
  await g(work, 'commit', '--quiet', '-am', 'a fix');
  await g(work, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
  await g(work, 'branch', '--quiet', '-D', 'side');
  const bin = await ghStub(dir);
  const env = {
    PATH: `${bin}:${Bun.env['PATH'] ?? ''}`,
    GH_CALLS: join(dir, 'calls'),
    GH_TOKEN: 'tok',
    GITHUB_REPOSITORY: REPO,
    GITHUB_OUTPUT: join(dir, 'output'),
    // The push URL the step names, routed to the local origin.
    // Appended after the temp tree's own config entries, which it numbers from 0.
    GIT_CONFIG_COUNT: String(TREE_CONFIG + 1),
    [`GIT_CONFIG_KEY_${TREE_CONFIG}`]: `url.${origin}.insteadOf`,
    [`GIT_CONFIG_VALUE_${TREE_CONFIG}`]: PUSH_URL,
  };
  const calls = async () =>
    (await Bun.file(env.GH_CALLS).exists()) ? Bun.file(env.GH_CALLS).text() : '';
  const output = async () => Bun.file(env.GITHUB_OUTPUT).text();
  return { dir, work, origin, env, g, calls, output };
}

describe('unit · next-sync.yml · the merge step, run', () => {
  test('a clean merge lands on next and ci.yml is dispatched there', async () => {
    const { work, origin, env, g, calls, output } = await repos(false);
    const before = await g(origin, 'rev-parse', 'refs/heads/next');
    const out = await bash(script('merge'), work, env);
    expect({ ok: out.ok, output: out.output }).toMatchObject({ ok: true });
    expect(await g(origin, 'rev-parse', 'refs/heads/next')).not.toBe(before);
    // next now holds main.
    await g(origin, 'merge-base', '--is-ancestor', 'refs/heads/main', 'refs/heads/next');
    expect(await calls()).toBe('workflow run ci.yml --ref next\n');
    expect(await output()).toBe('conflict=false\n');
  });

  test('a conflict pushes nothing and hands on the conflicted file', async () => {
    const { work, origin, env, g, calls, output } = await repos(true);
    const before = await g(origin, 'rev-parse', 'refs/heads/next');
    const out = await bash(script('merge'), work, env);
    expect({ ok: out.ok, output: out.output }).toMatchObject({ ok: true });
    expect(await g(origin, 'rev-parse', 'refs/heads/next')).toBe(before);
    expect(await calls()).toBe('');
    expect(await output()).toBe('conflict=true\nfiles<<NEXT_SYNC_FILES\na.txt\nNEXT_SYNC_FILES\n');
  });
});

describe('unit · next-sync.yml · the report step, run', () => {
  const TITLE = 'next-sync: main does not merge cleanly into next';
  const report = async (conflict: boolean, issues: readonly object[]) => {
    const dir = await scratch();
    const bin = await ghStub(dir);
    const env = {
      PATH: `${bin}:${Bun.env['PATH'] ?? ''}`,
      GH_CALLS: join(dir, 'calls'),
      GH_ISSUES: JSON.stringify(issues),
      CONFLICT: String(conflict),
      FILES: 'a.txt',
      RUN_URL: 'https://example.test/run/1',
      RUNNER_TEMP: dir,
    };
    await Bun.write(join(dir, 'work', '.keep'), '');
    const out = await bash(script('report'), join(dir, 'work'), env);
    const [list, ...calls] = (await Bun.file(env.GH_CALLS).text()).split('\n').filter(Boolean);
    // The lookup comes first, every time: nothing is filed or closed unread.
    expect(list).toStartWith('issue list --state open --author app/github-actions --search ');
    const bodyFile = Bun.file(join(dir, 'next-sync.md'));
    return { ok: out.ok, calls, body: (await bodyFile.exists()) ? await bodyFile.text() : '' };
  };

  test('a conflict with no twin open files one issue, and the run is red', async () => {
    const got = await report(true, [{ number: 9, title: `${TITLE} (old)` }]);
    expect(got.ok).toBe(false);
    expect(got.calls).toHaveLength(1);
    expect(got.calls[0]).toStartWith(`issue create --title ${TITLE} --body-file `);
    expect(got.body).toContain('a.txt');
  });

  test('a conflict with its twin open comments on it', async () => {
    const got = await report(true, [{ number: 7, title: TITLE }]);
    expect(got.ok).toBe(false);
    expect(got.calls[0]).toStartWith('issue comment 7 --body-file ');
    expect(got.calls).toHaveLength(1);
  });

  test('a clean week closes the open twin, and is green', async () => {
    const got = await report(false, [{ number: 7, title: TITLE }]);
    expect(got.ok).toBe(true);
    expect(got.calls).toEqual([
      'issue close 7 --comment main merged cleanly into next: https://example.test/run/1',
    ]);
  });

  test('a clean week with nothing open does nothing', async () => {
    const got = await report(false, []);
    expect(got).toMatchObject({ ok: true, calls: [] });
  });
});
