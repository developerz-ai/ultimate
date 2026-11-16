// The stale-tracker rule of the `roadmap` step, over fixture trees with an injected clock, and the
// git reader under it against throwaway repositories whose commit dates are pinned — never the
// wall clock, so no case turns red because a calendar moved.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { git } from './release-due-git';
import {
  gitLastTouch,
  type LastTouch,
  STALE_PLAN_DAYS,
  stalePlanFindings,
} from './roadmap-stale-plans';
import { REPO_SCAN_TIMEOUT_MS } from './run';

// Spawns real git processes, so it runs on the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-11-15T12:00:00Z');
const now = (): number => NOW;
const DIR = 'docs/plans/2026/01/01/101-x';
const PATH = `${DIR}/status.yml`;

const made: string[] = [];
afterAll(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const tracker = (status: string, lastUpdated?: string): string =>
  [
    'plan: 101-x',
    `status: ${status}        # not_started | in_progress | blocked | complete | superseded`,
    'slices: []',
    ...(lastUpdated === undefined ? [] : [`last_updated: ${lastUpdated}`]),
    '',
  ].join('\n');

/** A root holding `files` (repo-relative path → text). */
async function treeWith(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'roadmap-stale-'));
  made.push(root);
  for (const [path, text] of Object.entries(files)) await Bun.write(join(root, path), text);
  return root;
}

/** A reader answering `touch` for every directory: the rule is under test, not git. */
const touched =
  (touch: LastTouch | undefined) =>
  async (_root: string, _dir: string): Promise<LastTouch | undefined> =>
    touch;

const daysAgo = (days: number, boundary = false): LastTouch => ({
  at: NOW - days * DAY_MS,
  boundary,
});

const codes = async (root: string, touch: LastTouch | undefined): Promise<readonly string[]> =>
  (await stalePlanFindings(root, { now, lastTouch: touched(touch) })).map((f) => f.code);

describe('unit · a tracker nobody touches stops reading as live work', () => {
  test('in_progress and untouched for more than the limit is X_ROADMAP_TRACKER_STALE', async () => {
    const root = await treeWith({ [PATH]: tracker('in_progress') });
    const findings = await stalePlanFindings(root, {
      now,
      lastTouch: touched(daysAgo(STALE_PLAN_DAYS + 1)),
    });
    expect(findings.map((f) => f.code)).toEqual(['X_ROADMAP_TRACKER_STALE']);
    const [finding] = findings;
    expect(finding?.at).toBe(PATH);
    expect(finding?.cause).toContain(`${String(STALE_PLAN_DAYS + 1)} days`);
    expect(finding?.cause).toContain('2026-10-15');
    // The fix names the exact edit and the command that re-checks it.
    expect(finding?.fix).toStartWith(
      "sed -i.bak 's/^status: in_progress/status: superseded/' docs/plans/2026/01/01/101-x/status.yml && rm docs/plans/2026/01/01/101-x/status.yml.bak && bun run scripts/roadmap.ts --json",
    );
    expect(finding?.fix).toContain(`status: superseded`);
    expect(finding?.fix).toContain(PATH);
  });

  test('exactly the limit is not stale: the rule is "more than"', async () => {
    const root = await treeWith({ [PATH]: tracker('in_progress') });
    expect(await codes(root, daysAgo(STALE_PLAN_DAYS))).toEqual([]);
  });

  test.each(['not_started', 'blocked', 'complete', 'superseded'])(
    'a %s tracker is never stale, however old',
    async (status) => {
      const root = await treeWith({ [PATH]: tracker(status) });
      expect(await codes(root, daysAgo(400))).toEqual([]);
    },
  );

  test('a directory git never saw is not judged — it is work not yet committed', async () => {
    const root = await treeWith({ [PATH]: tracker('in_progress', '2020-01-01') });
    expect(await codes(root, undefined)).toEqual([]);
  });

  test('broken YAML is plan-status’s finding, not this rule’s', async () => {
    const root = await treeWith({ [PATH]: 'status: [in_progress\n' });
    expect(await codes(root, daysAgo(400))).toEqual([]);
  });

  test('each stale tracker is its own finding; a fresh one beside it is not', async () => {
    const root = await treeWith({
      'docs/plans/a/status.yml': tracker('in_progress'),
      'docs/plans/b/status.yml': tracker('in_progress'),
    });
    const findings = await stalePlanFindings(root, {
      now,
      lastTouch: async (_root, dir) => (dir === 'docs/plans/a' ? daysAgo(90) : daysAgo(1)),
    });
    expect(findings.map((f) => f.at)).toEqual(['docs/plans/a/status.yml']);
  });
});

describe('unit · a shallow clone cannot date a directory, so the tracker dates itself', () => {
  test('a boundary commit is no date: an old last_updated still finds the tracker stale', async () => {
    const root = await treeWith({ [PATH]: tracker('in_progress', '2026-09-01') });
    const findings = await stalePlanFindings(root, {
      now,
      lastTouch: touched(daysAgo(1, true)),
    });
    expect(findings.map((f) => f.code)).toEqual(['X_ROADMAP_TRACKER_STALE']);
    expect(findings[0]?.cause).toContain('last_updated');
  });

  test('a boundary commit with a recent last_updated is not stale', async () => {
    const root = await treeWith({ [PATH]: tracker('in_progress', '2026-11-10') });
    expect(await codes(root, daysAgo(1, true))).toEqual([]);
  });

  test('a boundary with no last_updated is an upper bound: old enough is still stale', async () => {
    const root = await treeWith({ [PATH]: tracker('in_progress') });
    expect(await codes(root, daysAgo(1, true))).toEqual([]);
    expect(await codes(root, daysAgo(STALE_PLAN_DAYS + 5, true))).toEqual([
      'X_ROADMAP_TRACKER_STALE',
    ]);
  });

  test('a last_updated later than the boundary cannot rescue it: the file existed by then', async () => {
    const root = await treeWith({ [PATH]: tracker('in_progress', '2026-11-14') });
    expect(await codes(root, daysAgo(STALE_PLAN_DAYS + 5, true))).toEqual([
      'X_ROADMAP_TRACKER_STALE',
    ]);
  });
});

const GIT_ID = [
  '-c',
  'user.email=t@example.test',
  '-c',
  'user.name=t',
  '-c',
  'commit.gpgsign=false',
];

/** Commit everything in `dir` with both dates pinned to `iso`. */
async function commitAt(dir: string, iso: string, message: string): Promise<void> {
  const env = { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso };
  expect((await git([...GIT_ID, 'add', '-A'], dir, env)).ok).toBe(true);
  const done = await git([...GIT_ID, 'commit', '--quiet', '-m', message], dir, env);
  expect(done.ok, done.output).toBe(true);
}

/** A repository whose plan directory was last touched on 2026-09-01 and something else later. */
async function repoWithHistory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'roadmap-stale-git-'));
  made.push(root);
  expect((await git(['init', '--quiet', '--initial-branch=main'], root)).ok).toBe(true);
  await Bun.write(join(root, 'README.md'), 'r\n');
  await commitAt(root, '2026-08-01T00:00:00Z', 'root');
  await Bun.write(join(root, PATH), tracker('in_progress'));
  await commitAt(root, '2026-09-01T00:00:00Z', 'plan');
  await Bun.write(join(root, 'README.md'), 'r2\n');
  await commitAt(root, '2026-11-10T00:00:00Z', 'elsewhere');
  return root;
}

describe('unit · the dates come from git', () => {
  test('the newest commit touching the directory dates it, not a later commit elsewhere', async () => {
    const root = await repoWithHistory();
    expect(await gitLastTouch(root, DIR)).toEqual({
      at: Date.parse('2026-09-01T00:00:00Z'),
      boundary: false,
    });
    expect(await gitLastTouch(root, 'docs/plans/never')).toBeUndefined();
  });

  test('not a repository at all is no answer, never a throw', async () => {
    const root = await treeWith({ [PATH]: tracker('in_progress') });
    expect(await gitLastTouch(root, DIR)).toBeUndefined();
  });

  test('a depth-1 clone answers its boundary commit, marked as one', async () => {
    const source = await repoWithHistory();
    const parent = await mkdtemp(join(tmpdir(), 'roadmap-stale-shallow-'));
    made.push(parent);
    const clone = join(parent, 'clone');
    // A file URL, never a path: git honours `--depth` only over a transport, not a local copy.
    const url = Bun.pathToFileURL(source).href;
    expect((await git(['clone', '--quiet', '--depth=1', url, clone], parent)).ok).toBe(true);
    expect(await gitLastTouch(clone, DIR)).toEqual({
      at: Date.parse('2026-11-10T00:00:00Z'),
      boundary: true,
    });
  });

  test('the rule over real git: the 2026-09-01 plan is stale on 2026-11-15', async () => {
    const root = await repoWithHistory();
    const findings = await stalePlanFindings(root, { now, lastTouch: gitLastTouch });
    expect(findings.map((f) => f.code)).toEqual(['X_ROADMAP_TRACKER_STALE']);
    expect(findings[0]?.cause).toContain('75 days');
  });
});
