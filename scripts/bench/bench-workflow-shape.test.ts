// The shape of `.github/workflows/bench.yml` that keeps its weekly figures arriving: triggers that
// actually fire, and a pull-request step whose refusal names what it needs and what that costs. Reads
// the REAL workflow — each assertion is one a quiet edit to it would break with nothing red.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from '../lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

interface Step {
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
}

interface Workflow {
  readonly on?: Readonly<Record<string, unknown>>;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs?: Readonly<Record<string, { readonly steps?: readonly Step[] }>>;
}

const workflow = Bun.YAML.parse(
  await Bun.file(`${repoRoot()}/.github/workflows/bench.yml`).text(),
) as Workflow;
const steps = workflow.jobs?.['bench']?.steps ?? [];
const pr = steps.find((step) => step.run?.includes('gh pr create'));
/** The step's shell without its comment lines: asked of the code, never the prose. */
const prShell = (pr?.run ?? '')
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

describe('unit · bench.yml fires on triggers that can fire', () => {
  test('a weekly schedule and a manual dispatch — never `release`', () => {
    // release-tag.yml creates every Release with GITHUB_TOKEN, and an event that token raises
    // starts no workflow run: a `release` trigger here never fired once (no bench run between
    // 2026-11-10 and 31.22.3, twenty-odd Releases later) while the docs said "on each release".
    expect(Object.keys(workflow.on ?? {})).toEqual(['schedule', 'workflow_dispatch']);
  });

  test('the job token writes only the branch and the pull request', () => {
    expect(workflow.permissions).toEqual({ contents: 'write', 'pull-requests': 'write' });
  });
});

describe('unit · a new measurement supersedes the last one', () => {
  test('one fixed branch, force-pushed, and an open pull request is updated, never doubled', () => {
    // A branch per run left #1140 and #1172 open side by side, each unmergeable by the next week.
    expect(prShell).toContain("BRANCH='bench/re-measured'");
    expect(prShell).not.toContain('BRANCH="bench/');
    expect(prShell).toContain('git push --force');
    expect(prShell).toContain('gh pr list --head "$BRANCH" --state open');
    // The `exit 0` is what keeps an updated pull request from falling through to a refused create.
    expect(prShell).toMatch(/gh pr edit "\$OPEN" --body "\$BODY"\n\s+exit 0\n/);
    expect(prShell).toContain('if ! gh pr create');
    expect(prShell.indexOf('gh pr edit "$OPEN"')).toBeLessThan(
      prShell.indexOf('if ! gh pr create'),
    );
  });
});

describe('unit · a refused pull request names what it needs and what that costs', () => {
  test('gh pr create is guarded, and its failure prints the exact fix and fails the run', () => {
    expect(pr?.if).toBe(`\${{ always() }}`);
    expect(prShell).toContain('if ! gh pr create');
    expect(prShell).toContain('::error::');
    expect(prShell).toContain('needs GitHub Actions allowed to create pull requests');
    expect(prShell).toContain('required reviews must come from CODEOWNERS');
    expect(prShell).toContain(`gh pr create --head \${BRANCH} --fill`);
    // The approve switch also lets any workflow's token approve a pull request, defeating a
    // one-review branch protection: it is never the printed remedy.
    expect(prShell).not.toContain('can_approve_pull_request_reviews');
    expect(prShell).toContain('exit 1');
    expect(prShell).not.toContain('|| true');
  });
});
