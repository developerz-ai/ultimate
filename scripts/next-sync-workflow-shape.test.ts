// The shape of `.github/workflows/next-sync.yml` that keeps `next` a branch a major can be cut from:
// weekly, `main` merged in and gated by a dispatched ci.yml, ONE tracking issue (a conflict, or a
// workflow change the job token may not push) found by its exact title and closed by the next clean run, write tokens held per job with no dependency code beside
// them, and no expression spliced into shell. Reads the REAL workflow.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { expr, type Job, readWorkflow, type Step } from './lib/ci-workflow-read';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

interface Shape {
  readonly on?: Readonly<Record<string, unknown>>;
  readonly permissions?: unknown;
  readonly concurrency?: { readonly group?: string; readonly 'cancel-in-progress'?: unknown };
  readonly jobs?: Readonly<Record<string, Job>>;
}

const workflow = (await readWorkflow('next-sync.yml')) as Shape;
const raw = await Bun.file(`${repoRoot()}/.github/workflows/next-sync.yml`).text();
const merge = workflow.jobs?.['merge'];
const report = workflow.jobs?.['report'];
const runOf = (job: Job | undefined): string =>
  (job?.steps ?? []).map((step: Step) => step.run ?? '').join('\n');
/** The one tracking issue's title: the workflow finds, comments on and closes it by this. */
const TITLE = 'next-sync: main is not merged into next';

describe('unit · next-sync.yml runs weekly and on dispatch, never on a push', () => {
  test('a weekly schedule and a manual dispatch, nothing else', () => {
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual(['schedule', 'workflow_dispatch']);
    const [entry] = (workflow.on?.['schedule'] as readonly { cron?: string }[] | undefined) ?? [];
    // Minute, hour, any day of the month, any month, ONE day of the week.
    expect(entry?.cron).toMatch(/^\d+ \d+ \* \* [0-6]$/);
  });

  test('one run at a time, never cancelled half-pushed', () => {
    expect(workflow.concurrency?.['cancel-in-progress']).toBe(false);
  });
});

describe('unit · next-sync.yml merges main into next and gates the result', () => {
  test('next is fetched or the run names the command that creates it', () => {
    const script = runOf(merge);
    expect(script).toContain('+refs/heads/next:refs/remotes/origin/next');
    expect(script).toContain('git push origin origin/main:refs/heads/next');
  });

  test('a clean merge is pushed to next and ci.yml dispatched there', () => {
    const script = runOf(merge);
    expect(script).toContain('git merge --no-edit origin/main');
    expect(script).toContain('HEAD:refs/heads/next');
    // A push made with the job token starts no workflow; a dispatch is GitHub's exception.
    expect(script).toContain('gh workflow run ci.yml --ref next');
  });

  test('a conflict is aborted, never pushed, and handed on as conflicted files', () => {
    const script = runOf(merge);
    expect(script).toContain('git merge --abort');
    expect(script).toContain('git diff --name-only --diff-filter=U');
    expect(script).toContain('blocked conflict "$files"');
  });

  test('a merge changing .github/workflows/ is never pushed with the job token', () => {
    // GitHub refuses it: the run would fail with no issue and next fall behind unseen.
    const script = runOf(merge);
    expect(script).toContain('git diff --name-only origin/next HEAD -- .github/workflows/');
    expect(script).toContain('blocked workflows "$workflows"');
    expect(merge?.steps?.find((s) => s.run)?.env?.['NEXT_SYNC_TOKEN']).toMatch(
      /^\$\{\{ secrets\.NEXT_SYNC_TOKEN \}\}$/,
    );
  });
});

describe('unit · next-sync.yml files one issue per blocked week, closed by its own clean run', () => {
  // It ran on `success` only, so a red merge job (no `next`, a refused push, a merge that failed
  // with no conflict) filed nothing: `next` fell behind with only a red run nobody reads to say so.
  test('the report runs after the merge, on its failure too, and is told which', () => {
    expect(report?.needs).toBe('merge');
    expect(report?.if).toBe(expr('!cancelled()'));
    const step = report?.steps?.find((one) => one.run);
    expect(step?.env?.['MERGE_RESULT']).toBe(expr('needs.merge.result'));
    expect(runOf(report)).toContain(`if [ "$MERGE_RESULT" != 'success' ]; then`);
  });

  test('found by its exact title, then commented on, created once, or closed', () => {
    const script = runOf(report);
    expect(script).toContain(`TITLE='${TITLE}'`);
    expect(script).toContain('select(.title == $t)');
    expect(script).toContain('gh issue comment "$open"');
    expect(script).toContain('gh issue create --title "$TITLE"');
    expect(script).toContain('gh issue close "$open"');
  });

  test('a blocked week stays red', () => {
    expect(runOf(report)).toMatch(/gh issue create[^\n]*\n[\s\S]*exit 1/);
  });
});

describe('unit · next-sync.yml holds least privilege', () => {
  test('read-only at the top; each write on the one job that needs it', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(merge?.permissions).toEqual({ contents: 'write', actions: 'write' });
    expect(report?.permissions).toEqual({ issues: 'write' });
  });

  test('no dependency code runs beside a write token, and no credential is persisted', () => {
    for (const job of [merge, report]) {
      for (const step of job?.steps ?? []) {
        expect(step.uses ?? '').not.toContain('./.github/actions/setup');
        expect(step.run ?? '').not.toMatch(/\bbun (install|run|x)\b|\bbunx\b/);
        if (step.uses?.startsWith('actions/checkout@')) {
          expect(step.with?.['persist-credentials']).toBe(false);
        }
      }
    }
  });

  test('every expression reaches shell through env, never spliced into run', () => {
    for (const job of [merge, report]) {
      for (const step of job?.steps ?? []) expect(step.run ?? '').not.toContain('${{');
    }
    expect(raw).toMatch(/uses: actions\/checkout@[0-9a-f]{40} # v\d/);
  });
});
