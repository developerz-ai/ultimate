// TEST-ONLY. What `gh` really prints for a run that has not finished: captured 2026-11-16 with
// `gh run list --status in_progress --json <RUN_FIELDS>` and `gh run view <id> --json <…>,jobs` on
// this repository. `conclusion` is the EMPTY STRING, never `null` — the shape `x ci` refused.

/** `gh run list --status in_progress`, verbatim. */
export const IN_PROGRESS_LIST = `[{"conclusion":"","createdAt":"2026-11-16T04:29:05Z","databaseId":43804367234,"displayTitle":"Push on main","headBranch":"main","headSha":"e3d6e1f555edbfc6d0728ea2d67a342bca50bb7d","status":"in_progress","url":"https://github.com/developerz-ai/ultimate/actions/runs/43804367234","workflowName":"CodeQL"}]`;

/** `gh run view --json …,jobs` of a queued run, verbatim: no job has started. */
export const QUEUED_VIEW = `{"conclusion":"","createdAt":"2026-11-11T20:36:51Z","databaseId":43097093630,"displayTitle":"chore: release 31.6.0","headBranch":"chore/release-31.6.0","headSha":"1efe8b1f58146bb6bb70c256e8a5f1ed47064c72","jobs":[],"status":"queued","url":"https://github.com/developerz-ai/ultimate/actions/runs/43097093630","workflowName":"ci"}`;

/**
 * A run mid-flight with one job running: the run row as captured above, the job in `gh`'s own
 * job shape. Built, not captured — no job was in flight to copy — so the job's and the step's
 * `""` are the run row's rule applied to the same `gh` serialiser.
 */
export const IN_PROGRESS_VIEW = JSON.stringify({
  ...JSON.parse(IN_PROGRESS_LIST)[0],
  jobs: [
    {
      completedAt: '0001-01-01T00:00:00Z',
      conclusion: '',
      databaseId: 1,
      name: 'Analyze (actions)',
      startedAt: '2026-11-16T04:29:12Z',
      status: 'in_progress',
      steps: [
        { conclusion: 'success', name: 'Set up job', number: 1, status: 'completed' },
        { conclusion: '', name: 'Initialize CodeQL', number: 2, status: 'in_progress' },
      ],
      url: 'https://github.com/developerz-ai/ultimate/actions/runs/43804367234/job/1',
    },
  ],
});
