// deploy-social-demo.yml: started only by a finished ci run on main or by hand, and red when the
// image it published is not the one serving. Split from `ci-workflow-shape.test.ts` at its ceiling.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { expr, text } from './lib/ci-workflow-read';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const deployDocument: unknown = Bun.YAML.parse(
  await Bun.file(`${repoRoot()}/.github/workflows/deploy-social-demo.yml`).text(),
);

describe('unit · deploy-social-demo.yml · only completed ci runs on main or dispatch start it', () => {
  const triggers = record(record(deployDocument)['on']);
  const workflowRun = record(triggers['workflow_run']);
  // Exact mappings keep added events and scope-changing filters from silently widening publish.
  const assertTriggers = (value: unknown): void => {
    const events = record(value);
    expect(Object.keys(events).sort()).toEqual(['workflow_dispatch', 'workflow_run']);
    expect(events['workflow_run']).toEqual({
      workflows: ['ci'],
      types: ['completed'],
      branches: ['main'],
    });
  };

  test('the real workflow has exactly the permitted events and workflow_run filters', () => {
    assertTriggers(triggers);
  });

  test('mapping key order does not change the trigger contract', () => {
    assertTriggers({
      workflow_dispatch: triggers['workflow_dispatch'],
      workflow_run: {
        branches: workflowRun['branches'],
        types: workflowRun['types'],
        workflows: workflowRun['workflows'],
      },
    });
  });

  test.each(['push', 'pull_request', 'schedule', 'workflow_call'])(
    'rejects an added %s event',
    (event) => {
      expect(() => assertTriggers({ ...triggers, [event]: {} })).toThrow();
    },
  );

  const withoutBranches = Object.fromEntries(
    Object.entries(workflowRun).filter(([key]) => key !== 'branches'),
  );
  test.each([
    ['missing branches', withoutBranches],
    ['extra branch', { ...workflowRun, branches: ['main', 'develop'] }],
    ['wildcard branch', { ...workflowRun, branches: ['*'] }],
    ['extra workflow', { ...workflowRun, workflows: ['ci', 'other'] }],
    ['wildcard workflow', { ...workflowRun, workflows: ['*'] }],
    ['extra type', { ...workflowRun, types: ['completed', 'requested'] }],
    ['extra filter', { ...workflowRun, 'branches-ignore': ['develop'] }],
  ] as const)('rejects workflow_run with %s', (_label, mutatedRun) => {
    expect(() => assertTriggers({ ...triggers, workflow_run: mutatedRun })).toThrow();
  });
});

// A frozen image updater reported nothing (plan 101, 33-ops-deploy-proof): `served` reds the run.
test('deploy-social-demo.yml: served needs build and verifies the sha-<7> it published', () => {
  const served = record(record(record(deployDocument)['jobs'])['served']);
  expect(served['needs']).toBe('build');
  const runs = listOf(served['steps'])
    .map((step) => text(record(step)['run']))
    .join('\n');
  expect(runs).toContain(
    'bunx x deploy verify --url https://social-media.ultimate.demo.developerz.ai --build "$BUILD" --timeout 10m --json',
  );
  const env = listOf(served['steps']).map((step) => record(record(step)['env'])['BUILD']);
  expect(env).toContain(expr('needs.build.outputs.short'));
});
