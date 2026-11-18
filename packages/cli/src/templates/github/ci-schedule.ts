// The weekly half of `ci.yml`: the trigger that gates a default branch nobody is pushing to, the
// concurrency and job condition that let it run, and the alarm that reaches a person when it goes
// red. Shared with the `ci-weekly-schedule` codemod, so an upgraded app gets these same bytes.

import { fnv1a } from '@ultimat3/core';
import { DEFAULT_RUNNER } from './runner';

/** The one issue a red scheduled run opens; the alarm finds it again by this exact title. */
export const ALARM_ISSUE_TITLE = 'Scheduled gate is red on the default branch';

/**
 * Sunday 04:MM UTC, the minute hashed (FNV-1a) from the app's name: apps scaffolded alike do not
 * queue at one instant, and 1–58 stays off the top of the hour, when GitHub delays schedules most.
 */
export function weeklyCron(name: string): string {
  return `${String(1 + (fnv1a(name) % 58))} 4 * * 0`;
}

/** The `schedule:` entry under `on:`, its reasoning kept beside it. */
export const scheduleTrigger = (name: string): string =>
  `  # Weekly, so a default branch nobody pushes to still learns that the world moved under it: a
  # yanked dependency, a retired base image, an expired fixture. GitHub runs this on the default
  # branch only, and turns it off in a public repository after 60 days with no activity there.
  schedule:
    - cron: '${weeklyCron(name)}'
`;

/** `concurrency:` and its group: the schedule arm first, then the push and pull request rule. */
export const CONCURRENCY_GROUP = `concurrency:
  # A scheduled run is keyed by its own id: sharing a group with nothing, it cancels no run and no
  # push can cancel it. The arm comes first because a schedule's event carries little else.
  group: ci-\${{ github.event_name == 'schedule' && format('schedule-{0}', github.run_id) || github.ref == format('refs/heads/{0}', github.event.repository.default_branch) && github.sha || github.ref }}
`;

/** The plan job's condition, which every other gate job inherits through `needs`. */
export const PLAN_CONDITION = `    # A scheduled run has no pull request to duplicate, so only that event is ever filtered.
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name != github.repository
`;

/** The job after the verdict, with the blank line that separates it from `verify`. */
export const ALARM_JOB = `
  # A failed schedule emails only whoever last edited the cron line, which may be a bot or nobody
  # still here. So the run keeps ONE issue: opened when it goes red, commented on while it stays
  # red, closed by the next green run. It runs no action and checks nothing out, so the only code
  # beside its token is \`gh\`; the \`image\` workflow publishes a push alone, so nothing ships from here.
  alarm:
    needs: verify
    if: \${{ !cancelled() && github.event_name == 'schedule' }}
    # NOT \`vars.CI_RUNNER\`: \`gh\` is on the GitHub-hosted image, and a configured label may lack it.
    runs-on: ${DEFAULT_RUNNER}
    timeout-minutes: 5
    # Replaces the workflow's grant for this job alone: no other job can write an issue.
    permissions:
      issues: write # open, comment on and close the one alarm issue
    steps:
      - name: report the scheduled verdict
        shell: bash
        env:
          GH_TOKEN: \${{ github.token }}
          GH_REPO: \${{ github.repository }}
          VERDICT: \${{ needs.verify.result }}
        run: |
          run_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
          # Its own assignment, so a failed lookup stops the job instead of reading as Issues off.
          issues_enabled="$(gh repo view --json hasIssuesEnabled --jq .hasIssuesEnabled)"
          # With Issues off there is nowhere to write: a green week must not turn red over that.
          if [ "$issues_enabled" != true ]; then
            echo "::warning::Issues are off here, so this verdict ($VERDICT) reaches nobody: $run_url"
            exit 0
          fi
          # Its own issue only: the author filter keeps a look-alike title from being commented on.
          existing="$(gh issue list --state open --author 'app/github-actions' \\
            --search 'in:title "${ALARM_ISSUE_TITLE}"' --json number,title \\
            --jq 'map(select(.title == "${ALARM_ISSUE_TITLE}"))[0].number // empty')"
          if [ "$VERDICT" = success ]; then
            if [ -n "$existing" ]; then
              gh issue close "$existing" --reason completed --comment "Green again: $run_url"
            fi
          elif [ -n "$existing" ]; then
            gh issue comment "$existing" --body "Still red: $run_url"
          else
            gh issue create --title '${ALARM_ISSUE_TITLE}' --body "The weekly gate failed with no push to blame: $run_url

          Reproduce it with bun run setup, then bun run verify. The next green scheduled run closes this issue."
          fi
`;
