// 31.47.0: `x new`'s ci.yml gates the default branch weekly and keeps one issue while that run is
// red, and its dependabot.yml leaves the Bun image to the repo's Bun pins. A workflow that already
// has a schedule made these decisions itself and is left alone; one that no longer holds the
// template's lines is reported with the diff, all or nothing.

import { CI_WORKFLOW_PATH } from '../templates/github/ci.yml';
import {
  ALARM_JOB,
  CONCURRENCY_GROUP,
  PLAN_CONDITION,
  scheduleTrigger,
} from '../templates/github/ci-schedule';
import { BUN_IMAGE_IGNORE, DEPENDABOT_PATH } from '../templates/github/dependabot.yml';
import type { Codemod, CodemodApp, CodemodResult } from './codemod';
import { editSnippets, mergeResults, readText } from './engine-edits';

const NOTHING: CodemodResult = { changed: [], skipped: [] };

const OLD_TRIGGERS = 'on:\n  push:\n  pull_request:\n';
const OLD_GROUP = `concurrency:
  group: ci-\${{ github.ref == format('refs/heads/{0}', github.event.repository.default_branch) && github.sha || github.ref }}
`;
const OLD_CONDITION = `    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name != github.repository
`;
const VERDICT_STEP = '      - run: bun run verify merge "$RUNNER_TEMP"/parts/*.json\n';
const POSTGRES_IGNORE = `      # A Postgres MAJOR is a planned migration (a new data directory), never a weekly bump.
      - dependency-name: postgres
        update-types: ['version-update:semver-major']
`;

/** A `schedule:` key inside the `on:` block, never a job of that name further down. */
const HAS_SCHEDULE = /^["']?on["']?:[^\n]*\n(?:(?:[ \t#][^\n]*)?\n)*?[ \t]+schedule:/m;
/** The name `x new` wrote into the workflow's header: the cron's seed, as it was for a new app. */
const APP_NAME = /^# The gate for ([^\s:]+):/m;

async function carryWorkflow(app: CodemodApp): Promise<CodemodResult> {
  const file = await readText(app, CI_WORKFLOW_PATH);
  if (file === undefined || HAS_SCHEDULE.test(file.text)) return NOTHING;
  const name = APP_NAME.exec(file.text)?.[1] ?? app.root;
  return editSnippets(app, CI_WORKFLOW_PATH, [
    { from: OLD_TRIGGERS, to: `${OLD_TRIGGERS}${scheduleTrigger(name)}` },
    { from: OLD_GROUP, to: CONCURRENCY_GROUP },
    { from: OLD_CONDITION, to: PLAN_CONDITION },
    { from: VERDICT_STEP, to: `${VERDICT_STEP}${ALARM_JOB}` },
  ]);
}

async function carryDependabot(app: CodemodApp): Promise<CodemodResult> {
  const file = await readText(app, DEPENDABOT_PATH);
  if (file === undefined || file.text.includes('dependency-name: oven/bun')) return NOTHING;
  return editSnippets(app, DEPENDABOT_PATH, [
    { from: POSTGRES_IGNORE, to: `${POSTGRES_IGNORE}${BUN_IMAGE_IGNORE}` },
  ]);
}

export const codemod: Codemod = {
  id: 'ci-weekly-schedule',
  since: '31.47.0',
  summary: `${CI_WORKFLOW_PATH}: a weekly gate of the default branch, with one issue kept while it is red; ${DEPENDABOT_PATH}: the Bun image moves with the repo's Bun pins`,
  run: async (app) => mergeResults([await carryWorkflow(app), await carryDependabot(app)]),
};
