// No check runs on `main` alone. A job that answers only after the merge reddens `main` on a green
// pull request — twice on 2026-11-19 (#1272: `deploy-proof`, `tutorial-run`). Every workflow a push
// to `main` starts runs on a pull request too, over the same paths, unless it publishes rather than
// checks; every ci.yml job a push to `main` runs, a pull request runs.

import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises'; // why: Bun has no directory listing primitive.
import { jobOf, readWorkflow, text } from './lib/ci-workflow-read';
import { repoRoot } from './lib/run';

/** Push-only on purpose: each publishes what the gate already checked, and answers no diff. */
const PUBLISHERS: Readonly<Record<string, string>> = {
  'wiki.yml':
    'publishes wiki/ to the GitHub wiki; the gate`s doc guards read those pages on every PR',
  'scorecard.yml': 'publishes the OpenSSF score of main; it checks no diff and never gates a merge',
};

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const triggersOf = async (file: string): Promise<Readonly<Record<string, unknown>>> =>
  record(record(await readWorkflow(file))['on']);

const pushesMain = (push: unknown): boolean => {
  const branches = record(push)['branches'];
  return Array.isArray(branches) && branches.includes('main');
};

const files = (await readdir(`${repoRoot()}/.github/workflows`)).filter((name) =>
  name.endsWith('.yml'),
);

describe('unit · workflows · nothing checks main alone', () => {
  test('every workflow a push to main starts runs on a pull request, over the same paths', async () => {
    const mainOnly: string[] = [];
    const pathsDiffer: string[] = [];
    for (const file of files) {
      const on = await triggersOf(file);
      if (!pushesMain(on['push']) || Object.hasOwn(PUBLISHERS, file)) continue;
      if (!Object.hasOwn(on, 'pull_request')) {
        mainOnly.push(file);
        continue;
      }
      const pushPaths = record(on['push'])['paths'];
      const prPaths = record(on['pull_request'])['paths'];
      if (JSON.stringify(pushPaths) !== JSON.stringify(prPaths)) pathsDiffer.push(file);
    }
    expect(mainOnly, 'add `pull_request:` with the push paths, or a PUBLISHERS row').toEqual([]);
    expect(pathsDiffer, 'a pull request must watch the paths main does').toEqual([]);
  });

  test('every publisher named here is still a workflow pushed on main', async () => {
    for (const file of Object.keys(PUBLISHERS)) {
      expect(files).toContain(file);
      expect(pushesMain((await triggersOf(file))['push'])).toBe(true);
    }
  });

  test('no ci.yml job a push runs is skipped on a pull request', async () => {
    const ci = await readWorkflow('ci.yml');
    const pushOnly = Object.entries(ci.jobs ?? {})
      .filter(([, job]) => /github\.event_name == 'push'|refs\/heads\/main/.test(text(job.if)))
      .filter(([, job]) => !text(job.if).includes("github.event_name == 'pull_request'"))
      .map(([name]) => name);
    expect(pushOnly).toEqual([]);
  });

  test('deploy-proof decides a pull request off its merge commit`s first parent', async () => {
    const proof = jobOf(await readWorkflow('ci.yml'), 'deploy-proof');
    const checkout = (proof.steps ?? []).find((step) => text(step.uses).startsWith('actions/'));
    expect(checkout?.with?.['fetch-depth']).toBe(2);
  });

  test('tutorial-run is grouped per ref: main never cancels a pull request`s run', async () => {
    const tutorials = await readWorkflow('tutorial-run.yml');
    expect(tutorials.concurrency?.group).toContain('github.ref');
  });
});
