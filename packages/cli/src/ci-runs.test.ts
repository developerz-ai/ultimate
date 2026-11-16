// `listRuns` / `viewRun` over what `gh` really prints for an unfinished run (`ci-runs-fixture.ts`):
// `conclusion: ""` is "no verdict yet", read as `null` — never `X_GH_RESPONSE_INVALID`.

import { describe, expect, test } from 'bun:test';
import { isFailed, isRunning, listRuns, viewRun } from './ci-runs';
import { IN_PROGRESS_LIST, IN_PROGRESS_VIEW, QUEUED_VIEW } from './ci-runs-fixture';
import type { ExecResult } from './exec';
import type { GhHost } from './gh';

const REPO = { owner: 'acme', name: 'app', slug: 'acme/app' };

/** A `gh` that answers every call with `stdout`. */
const answering = (stdout: string): GhHost => ({
  cwd: '/app',
  runner: async (command): Promise<ExecResult> => ({
    command,
    code: 0,
    ok: true,
    stdout,
    stderr: '',
    durationMs: 1,
  }),
});

describe('an unfinished run, as gh prints it', () => {
  test('gh run list: an in-progress run is running, with no verdict', async () => {
    const [run] = await listRuns(answering(IN_PROGRESS_LIST), REPO, 'main', 20);
    expect(run?.conclusion).toBeNull();
    expect(run !== undefined && isRunning(run)).toBe(true);
    expect(run !== undefined && isFailed(run)).toBe(false);
  });

  test('gh run view: a queued run with no job yet reads, and has no verdict', async () => {
    const viewed = await viewRun(answering(QUEUED_VIEW), REPO, 43097093630);
    expect(viewed.run.conclusion).toBeNull();
    expect(viewed.jobs).toEqual([]);
  });

  test('gh run view: a running job and its running step have no verdict either', async () => {
    const { jobs } = await viewRun(answering(IN_PROGRESS_VIEW), REPO, 43804367234);
    expect(jobs[0]?.conclusion).toBeNull();
    expect(jobs[0]?.steps.map((step) => step.conclusion)).toEqual(['success', null]);
  });
});
