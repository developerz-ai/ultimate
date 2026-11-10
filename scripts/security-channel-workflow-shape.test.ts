// The shape of `.github/workflows/security-channel.yml` that keeps its daily alarm honest: only a
// literal `true` passes, the label is provisioned before any `gh issue` call, `issues: write` is the
// only permission, and nothing is checked out. Each rule is a pure check over the workflow's text,
// run on the REAL file and on a mutated copy, so a quiet edit that breaks one goes red here.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

const WORKFLOW = '.github/workflows/security-channel.yml';
const LABEL = 'security-channel';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

interface Step {
  readonly uses?: string;
  readonly run?: string;
}

interface Workflow {
  readonly on?: Readonly<Record<string, unknown>>;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs?: Readonly<
    Record<string, { readonly permissions?: unknown; readonly steps?: readonly Step[] }>
  >;
}

/** Shell lines without comments: ordering is asked of the code, never the prose. */
const shellOf = (steps: readonly Step[]): string =>
  steps
    .map((step) => step.run ?? '')
    .join('\n')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

/** Every rule the workflow breaks, by name; empty is the shape held. */
function shapeGaps(text: string): readonly string[] {
  const workflow = Bun.YAML.parse(text) as Workflow;
  const gaps: string[] = [];
  const jobs = Object.values(workflow.jobs ?? {});
  const steps = jobs.flatMap((job) => job.steps ?? []);
  const shell = shellOf(steps);
  const at = (needle: string): number => shell.indexOf(needle);

  if (JSON.stringify(workflow.permissions) !== JSON.stringify({ issues: 'write' })) {
    gaps.push('permissions');
  }
  if (jobs.some((job) => job.permissions !== undefined)) gaps.push('job-permissions');
  if (steps.some((step) => step.uses !== undefined)) gaps.push('checkout');
  if (!Object.keys(workflow.on ?? {}).includes('schedule')) gaps.push('schedule');

  // The only pass is the literal string `true`: `false`, an error text or an empty read all alarm.
  const passes = [...shell.matchAll(/if \[ (.+?) \]; then\s*\n\s*echo [^\n]*\n\s*exit 0/g)];
  if (passes.length !== 1 || passes[0]?.[1] !== '"$enabled" = "true"') gaps.push('literal-true');
  if (!shell.includes("private-vulnerability-reporting\" --jq '.enabled'")) gaps.push('read');

  const create = at(`gh label create ${LABEL}`);
  const issue = at('gh issue');
  if (create === -1 || issue === -1 || create > issue) gaps.push('label-first');
  if (!shell.includes(`gh api "repos/\${GITHUB_REPOSITORY}/labels/${LABEL}" >/dev/null 2>&1 ||`)) {
    gaps.push('label-confirm');
  }
  // The alarm path ends red, so the run's badge says what the issue says.
  if (!/gh issue create[^\n]*\n\s*fi\s*\n\s*exit 1\s*$/.test(shell.trimEnd()))
    gaps.push('exit-red');
  return gaps;
}

const real = await Bun.file(`${repoRoot()}/${WORKFLOW}`).text();

describe('security-channel.yml holds its shape', () => {
  test('the real workflow breaks no rule', () => {
    expect(shapeGaps(real)).toEqual([]);
  });
});

describe('a mutated copy goes red on the rule it breaks', () => {
  const mutate = (from: string, to: string): string => {
    expect(real).toContain(from);
    return real.replace(from, to);
  };

  test('a truthy test instead of the literal `true`', () => {
    expect(shapeGaps(mutate('[ "$enabled" = "true" ]', '[ -n "$enabled" ]'))).toContain(
      'literal-true',
    );
  });

  test('a comparison that also passes on `false`', () => {
    expect(shapeGaps(mutate('[ "$enabled" = "true" ]', '[ "$enabled" != "" ]'))).toContain(
      'literal-true',
    );
  });

  test('a second permission', () => {
    expect(
      shapeGaps(mutate('  issues: write\n', '  issues: write\n  contents: write\n')),
    ).toContain('permissions');
  });

  test('a checkout step', () => {
    const withCheckout = mutate(
      '    steps:\n',
      '    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n',
    );
    expect(shapeGaps(withCheckout)).toContain('checkout');
  });

  test('the issue lookup moved above the label creation', () => {
    const list =
      '          existing="$(gh issue list --label security-channel --state open --limit 1 --json number --jq \'.[0].number // empty\')"\n';
    const moved = mutate(list, '').replace(
      '          if ! err="$(gh label create',
      `${list}          if ! err="$(gh label create`,
    );
    expect(shapeGaps(moved)).toContain('label-first');
  });

  test('the alarm path no longer fails the run', () => {
    expect(shapeGaps(real.replace(/exit 1\s*$/, 'exit 0\n'))).toContain('exit-red');
  });
});
