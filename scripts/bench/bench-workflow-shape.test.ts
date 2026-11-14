// The shape of `.github/workflows/bench.yml` that keeps its weekly figures arriving: triggers that
// actually fire, and a pull-request step whose refusal names the repository setting to flip. Reads
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

describe('unit · a refused pull request names the setting that refused it', () => {
  test('gh pr create is guarded, and its failure prints the exact fix and fails the run', () => {
    expect(pr?.if).toBe(`\${{ always() }}`);
    expect(prShell).toContain('if ! gh pr create');
    expect(prShell).toContain(
      `gh api -X PUT \\"repos/\${GITHUB_REPOSITORY}/actions/permissions/workflow\\" -F can_approve_pull_request_reviews=true`,
    );
    expect(prShell).toContain('::error::');
    expect(prShell).toContain('exit 1');
    expect(prShell).not.toContain('|| true');
  });
});
