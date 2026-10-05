// The decision ci.yml's `deploy-proof` job runs on: when may a push to main skip the rolling
// upgrade? Pure functions over fixtures — the GitHub API and git are the CLI's, never a test's.

import { describe, expect, test } from 'bun:test';
import type { DeployProofInput, Predecessor } from './deploy-proof-due';
import {
  changedFilesCommand,
  deployProofDue,
  jobConclusion,
  parseRuns,
  predecessorRun,
  touchesVerdict,
} from './deploy-proof-due';
import { run } from './lib/run';

const GREEN: Predecessor = { runId: 41, headSha: 'a'.repeat(40), conclusion: 'success' };

const push = (overrides: Partial<DeployProofInput> = {}): DeployProofInput => ({
  event: 'push',
  subject: 'fix: a page title',
  predecessor: GREEN,
  changed: ['wiki/Home.md'],
  ...overrides,
});

describe('unit · deploy-proof-due · the decision', () => {
  test('a push that moved nothing deciding since a GREEN proof skips, and names its base', () => {
    expect(deployProofDue(push())).toEqual({
      run: false,
      reason: `no file that decides the proof moved since ${GREEN.headSha}, whose proof passed (run ${String(GREEN.runId)})`,
      base: GREEN.headSha,
    });
  });

  // K15: the filter diffed against `github.event.before` alone, so a red proof on A was hidden by
  // a B that touched no deciding path — and release.yml then published from B.
  test('a RED predecessor forces the proof, whatever this push changed', () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', 'action_required']) {
      const decision = deployProofDue(push({ predecessor: { ...GREEN, conclusion } }));
      expect({ conclusion, run: decision.run }).toEqual({ conclusion, run: true });
      expect(decision.reason).toContain(conclusion);
      expect(decision.base).toBeUndefined();
    }
  });

  test('an UNKNOWN predecessor forces it: still running, no deploy-proof job, or no run at all', () => {
    expect(deployProofDue(push({ predecessor: { ...GREEN, conclusion: null } })).run).toBe(true);
    expect(deployProofDue(push({ predecessor: undefined })).run).toBe(true);
  });

  test('a green predecessor whose diff could not be read forces it', () => {
    expect(deployProofDue(push({ changed: undefined })).run).toBe(true);
  });

  test('a deciding file moved since the green proof runs it, naming the file', () => {
    const decision = deployProofDue(push({ changed: ['wiki/Home.md', 'docker/Dockerfile'] }));
    expect(decision.run).toBe(true);
    expect(decision.reason).toContain('docker/Dockerfile');
  });

  test('a release commit always runs it: release.yml publishes from exactly this commit', () => {
    const decision = deployProofDue(push({ subject: 'release: 24.0.0 (#646)', changed: [] }));
    expect(decision.run).toBe(true);
    expect(decision.reason).toContain('release');
    // A subject that merely mentions a release is not one.
    expect(deployProofDue(push({ subject: 'docs: the release: notes' })).run).toBe(false);
  });

  test('anything but a push to main — a manual run — always runs it', () => {
    expect(deployProofDue(push({ event: 'workflow_dispatch' })).run).toBe(true);
  });
});

describe('unit · deploy-proof-due · the paths that decide the verdict', () => {
  test('the chart, the image, the deploy command and the serving path decide it', () => {
    for (const file of [
      '.github/workflows/ci.yml',
      'docker/helm/values.yaml',
      'packages/cli/src/templates/scaffold-dockerfile.ts',
      'packages/cli/src/cmd-deploy.ts',
      'packages/cli/src/serve.ts',
      'packages/cli/src/role-web.ts',
      'packages/cli/src/runtime-env.ts',
      'packages/core/src/lifecycle.ts',
      'packages/http/src/server.ts',
      'packages/http/src/stages.ts',
      // Every packages/* is packed into the proof app, so a manifest decides what ships in it.
      'packages/realtime/package.json',
      // The Bun that packs, scaffolds and builds; the root install the CLI runs on.
      '.github/actions/setup/action.yml',
      'bun.lock',
      'package.json',
      // The rule itself: a change to it is proved, never skipped by itself.
      'scripts/deploy-proof-due.ts',
    ]) {
      expect({ file, decides: touchesVerdict([file]) }).toEqual({ file, decides: file });
    }
  });

  test('docs, the wiki and unrelated packages do not', () => {
    expect(
      touchesVerdict([
        'wiki/Home.md',
        'packages/money/src/money.ts',
        'packages/money/README.md',
        'README.md',
        'scripts/deploy-proof-due.test.ts',
        'examples/dummy/package.json',
      ]),
    ).toBe(undefined);
  });
});

describe('unit · deploy-proof-due · reading the GitHub API', () => {
  const runs = [
    { id: 9, run_number: 120, head_sha: 'c'.repeat(40), status: 'in_progress' },
    { id: 8, run_number: 119, head_sha: 'b'.repeat(40), status: 'completed' },
    { id: 7, run_number: 118, head_sha: 'a'.repeat(40), status: 'completed' },
  ];

  test('the predecessor is the newest run on main started BEFORE this one', () => {
    const parsed = parseRuns({ workflow_runs: runs });
    expect(predecessorRun(parsed, 120)).toEqual({ id: 8, runNumber: 119, headSha: 'b'.repeat(40) });
    // A run that started after this one (a later push) is never this push's predecessor.
    expect(predecessorRun(parsed, 119)?.id).toBe(7);
    expect(predecessorRun(parsed, 118)).toBeUndefined();
  });

  test('a payload that is not the runs list is no runs, never a throw', () => {
    expect(parseRuns(null)).toEqual([]);
    expect(parseRuns({ workflow_runs: [{ id: 'x' }, 7] })).toEqual([]);
  });

  test('the deploy-proof job`s conclusion, by job name; absent or unfinished is null', () => {
    const jobs = (conclusion: unknown) => ({
      jobs: [
        { name: 'verify', conclusion: 'success' },
        { name: 'deploy-proof', conclusion },
      ],
    });
    expect(jobConclusion(jobs('failure'), 'deploy-proof')).toBe('failure');
    expect(jobConclusion(jobs(null), 'deploy-proof')).toBeNull();
    expect(
      jobConclusion({ jobs: [{ name: 'verify', conclusion: 'success' }] }, 'deploy-proof'),
    ).toBe(null);
    expect(jobConclusion('junk', 'deploy-proof')).toBeNull();
  });
});

describe('unit · deploy-proof-due · the diff sees both ends of a move', () => {
  // Rename detection lists only the NEW path, so a deciding file moved out of VERDICT_PATHS read
  // as an unrelated file appearing — and the proof skipped over the change.
  test('the command turns rename detection off', () => {
    expect(changedFilesCommand('b'.repeat(40))).toEqual([
      'git',
      'diff',
      '--no-renames',
      '--name-only',
      'b'.repeat(40),
      'HEAD',
    ]);
  });

  test('in a real repository, a deciding file moved out of the paths is still a change', async () => {
    const dir = `${Bun.env['TMPDIR'] ?? '/tmp'}/deploy-proof-due-${crypto.randomUUID()}`;
    try {
      const git = async (...argv: string[]): Promise<string> => {
        const result = await run(
          [
            'git',
            '-c',
            'user.email=t@example.test',
            '-c',
            'user.name=t',
            '-c',
            'commit.gpgsign=false',
            ...argv,
          ],
          { cwd: dir },
        );
        expect({ argv, ok: result.ok }).toEqual({ argv, ok: true });
        return result.output;
      };
      // Big enough that git pairs the two paths as a rename. `Bun.write` creates the directories.
      await Bun.write(`${dir}/docker/Dockerfile`, 'FROM scratch\n'.repeat(40));
      await Bun.write(`${dir}/elsewhere/.keep`, '');
      await git('init', '--quiet');
      await git('add', '.');
      await git('commit', '--quiet', '-m', 'base');
      const base = (await git('rev-parse', 'HEAD')).trim();
      await git('mv', 'docker/Dockerfile', 'elsewhere/Dockerfile');
      await git('commit', '--quiet', '-m', 'move');

      const [, ...argv] = changedFilesCommand(base);
      const changed = (await git(...argv)).split('\n').filter((line) => line !== '');
      expect(changed.sort()).toEqual(['docker/Dockerfile', 'elsewhere/Dockerfile']);
      expect(touchesVerdict(changed)).toBe('docker/Dockerfile');
    } finally {
      await run(['rm', '-rf', dir]);
    }
  });
});
