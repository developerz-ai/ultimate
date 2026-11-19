// No check runs on `main` alone. A job that answers only after the merge reddens `main` on a green
// pull request — twice on 2026-11-19 (#1272: `deploy-proof`, `tutorial-run`). Every workflow a push
// to `main` starts runs on a pull request too, over the same paths, unless it publishes rather than
// checks; every ci.yml job a push to `main` runs, a pull request runs.

import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises'; // why: Bun has no directory listing primitive.
import { jobOf, readWorkflow, text } from './lib/ci-workflow-read';
import { repoRoot } from './lib/run';
import { evaluateIf } from './lib/workflow-if';

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

  // Evaluated, never matched: a substring test passed an `if` that named `pull_request` inside a
  // main-ref guard and so skipped every pull request (`scripts/lib/workflow-if.test.ts`).
  test('no ci.yml job a push to main runs is skipped on a pull request', async () => {
    const ci = await readWorkflow('ci.yml');
    const pushMain = { 'github.event_name': 'push', 'github.ref': 'refs/heads/main' };
    const pull = { 'github.event_name': 'pull_request', 'github.ref': 'refs/pull/1/merge' };
    const unreadable: string[] = [];
    const pushOnly: string[] = [];
    for (const [name, job] of Object.entries(ci.jobs ?? {})) {
      const onPush = evaluateIf(text(job.if), pushMain);
      const onPull = evaluateIf(text(job.if), pull);
      if (onPush === undefined || onPull === undefined) unreadable.push(name);
      else if (onPush && !onPull) pushOnly.push(name);
    }
    expect(unreadable, 'extend scripts/lib/workflow-if.ts to read these').toEqual([]);
    expect(pushOnly).toEqual([]);
  });

  test('deploy-proof decides a pull request off its merge commit`s first parent', async () => {
    const proof = jobOf(await readWorkflow('ci.yml'), 'deploy-proof');
    const checkout = (proof.steps ?? []).find((step) => text(step.uses).startsWith('actions/'));
    expect(checkout?.with?.['fetch-depth']).toBe(2);
  });

  // Path-filtered, it ran only when a listed file moved; a change in any other package that alters
  // a printed line a tutorial quotes started nothing, and the health row kept the last green.
  test('tutorial-run has a schedule trigger', async () => {
    const schedule = (await triggersOf('tutorial-run.yml'))['schedule'];
    expect(Array.isArray(schedule) && schedule.length > 0).toBe(true);
    const cron = Array.isArray(schedule) ? text(record(schedule[0])['cron']) : '';
    // Weekly: five fields, a fixed day of week. The health row's staleness bound is eight days.
    expect(cron).toMatch(/^\d+ \d+ \* \* \d$/);
  });

  test('tutorial-run is grouped per ref: main never cancels a pull request`s run', async () => {
    const tutorials = await readWorkflow('tutorial-run.yml');
    expect(tutorials.concurrency?.group).toContain('github.ref');
  });
});
