// The CI half of what `x new` writes: the gate workflow, cut into parallel parts by
// `x verify plan` and folded back by `x verify merge`, and the image workflow (`image.yml.ts`)
// that publishes only what that gate passed. Every command it runs is one of the app's own scripts
// — `bun run setup`, `bun run verify …` — never a restatement of the gate's steps (axiom 1).

import { REQUIRED_BUN } from '../../app-root';
import { DEFAULT_PLAN_PARTS } from '../../verify-plan';
import type { GeneratedFile, NameSet } from '../naming';
import { TEST_COMPOSE_PATH, TEST_ENV_PATH } from '../scaffold-test-services';
import { DEPENDABOT_PATH, dependabot } from './dependabot.yml';
import { IMAGE_WORKFLOW_PATH, imageWorkflow } from './image.yml';
import { RUNS_ON } from './runner';

/** Where the workflow lands. GitHub reads this path and no other. */
export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';

/** The workflow's `name:` — what `image.yml`'s `workflow_run` trigger waits on, spelled once. */
const CI_WORKFLOW_NAME = 'ci';

/**
 * Pinned by commit SHA with the version in the trailing comment, because this step runs before any
 * code of yours does and `@v2` is a tag its owner can move. `actions/*` follows its major tag
 * instead: GitHub owns the runner and the tag together. Same rule the framework's own
 * `.github/actions/setup/action.yml` states, and the same SHA.
 */
const SETUP_BUN = 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0';

/** The plan job's one command: the app's `verify` script, so the CLI it asks is the one installed. */
export const PLAN_COMMAND = `bun run verify plan --parts ${String(DEFAULT_PLAN_PARTS)} --json`;

/**
 * Every job's first three steps: the tree, the Bun floor, the install cache. `bun-version` is
 * `package.json`'s `engines.bun` floor exactly — the OLDEST runtime the app declares, so a call
 * that needs a newer Bun fails here rather than in the install of whoever took the app at its
 * word; never `latest`, a runtime change nobody chose. The cache is keyed on the lockfile.
 */
const SETUP_STEPS = `      - uses: actions/checkout@v7
      - uses: ${SETUP_BUN}
        with:
          # engines.bun in package.json, exactly: the oldest Bun this app says it runs on.
          bun-version: '${REQUIRED_BUN}'
      - uses: actions/cache@v6
        with:
          path: ~/.bun/install/cache
          key: bun-\${{ runner.os }}-\${{ hashFiles('bun.lock') }}
          restore-keys: bun-\${{ runner.os }}-`;

const ci = (app: NameSet): string => `name: ${CI_WORKFLOW_NAME}

# The gate for ${app.kebab}: \`bun run setup\` and \`bun run verify\`, the two commands \`README.md\`
# tells a human to run, on machines that have never seen this repository — the gate cut into
# parts that run side by side. \`x verify plan\` names the parts, each runs \`x verify --only\` on its
# slice, and \`x verify merge\` is the verdict: green only when the parts were the whole gate. A
# check that exists only in CI is one nobody can reproduce locally; each part reproduces with its
# own flags, and \`bun run verify\` alone is the same gate on one machine.
#
# No build step comes first: the \`budgets\` step runs \`x build --target static\` itself when
# \`.x/build-stats.json\` is missing or older than the source, as on every fresh runner.
#
# \`bun run setup\` brings up embedded Postgres in-process; the TEST services come from
# \`docker/docker-compose.test.yml\` — Postgres 18, Redis, NATS and S3 in RAM, durability and logs
# off — started by the same two lines a laptop runs, never a \`services:\` block that restates them.

# EVERY push, not just the default branch's. \`x new\` runs a plain \`git init\` and takes whatever
# \`init.defaultBranch\` this machine already agreed on, so a \`branches: [main]\` filter silently
# runs nothing on a repository whose branch is called something else — and \`CLAUDE.md\` promises a
# run on every push, which a filter would make untrue for the app that read it.
on:
  push:
  pull_request:

# A newer push to a branch makes the run already in flight for it worthless, so it is cancelled —
# except on the default branch, where every commit keeps its own verdict: that group is keyed by
# SHA, so nothing there can supersede anything.
concurrency:
  group: ci-\${{ github.ref == format('refs/heads/{0}', github.event.repository.default_branch) && github.sha || github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  # The plan: \`x verify plan\` cuts the gate into runners, and the matrix below is its answer read
  # by \`fromJSON\` — never a list of steps typed here, which a new gate step would silently miss.
  plan:
    # A branch in THIS repository with an open pull request fires both events for one commit, and
    # the push run already gates that exact tree — so the pull_request run is skipped, not paid for
    # twice. A pull request from a FORK fires no push here, and it still runs.
    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name != github.repository
    # A free GitHub-hosted runner unless the repository variable \`CI_RUNNER\` names another label.
    runs-on: ${RUNS_ON}
    timeout-minutes: 5
    outputs:
      matrix: \${{ steps.plan.outputs.matrix }}
    steps:
${SETUP_STEPS}
      - run: bun install
      - id: plan
        run: echo "matrix=$(${PLAN_COMMAND} | jq -c '.data.matrix')" >> "$GITHUB_OUTPUT"

  # One part of the gate per runner: \`x verify --only <steps> [--shard i/n]\`, its document kept.
  gate:
    name: gate (\${{ matrix.part }})
    needs: plan
    runs-on: ${RUNS_ON}
    # A bound on a HANG, not on cost: a step that never returns holds a runner until GitHub's
    # six-hour default expires, and the failure is invisible for all six of them.
    timeout-minutes: 20
    strategy:
      # Every part runs to its end: the verdict below needs each one's document, red or green.
      fail-fast: false
      matrix: \${{ fromJSON(needs.plan.outputs.matrix) }}
    steps:
${SETUP_STEPS}
      # Two steps rather than one \`&&\`, so the log names which half failed and times each.
      - run: bun run setup
      # What the part's \`needs\` asks for and no more: \`--wait\` returns once every healthcheck
      # passes, and only the URLs of what was started reach the suites — a URL to a server that is
      # not running is a red suite, where an absent one is a suite that skips.
      - if: matrix.needs == 'database'
        run: |
          docker compose -f ${TEST_COMPOSE_PATH} up -d --wait postgres
          grep '^TEST_DATABASE_URL=' ${TEST_ENV_PATH} >> "$GITHUB_ENV"
      - if: matrix.needs == 'services'
        run: |
          docker compose -f ${TEST_COMPOSE_PATH} up -d --wait
          cat ${TEST_ENV_PATH} >> "$GITHUB_ENV"
      # Under $RUNNER_TEMP, never in the checkout, where \`lint\` would walk the open file.
      - env:
          PART: \${{ matrix.part }}
          ONLY: \${{ matrix.only }}
          SHARD: \${{ matrix.shard }}
        run: |
          mkdir -p "$RUNNER_TEMP/parts"
          bun run verify --only "$ONLY" \${SHARD:+--shard "$SHARD"} --json > "$RUNNER_TEMP/parts/$PART.json"
      # Uploaded when the part is RED too: a part with no document reads, in the merge, as a step
      # nobody ran. \`overwrite\`, so a re-run's document replaces the attempt it re-ran.
      - uses: actions/upload-artifact@v7
        if: \${{ !cancelled() }}
        with:
          name: verify-part-\${{ matrix.part }}
          path: \${{ runner.temp }}/parts/\${{ matrix.part }}.json
          if-no-files-found: error
          overwrite: true

  # THE VERDICT: \`x verify merge\` is green only when the parts are provably the whole gate — every
  # step from exactly one part, every shard of a split over one corpus, each part green. It runs
  # when a part is red (\`!cancelled()\`), because a skipped verdict reads as no verdict.
  verify:
    needs: [plan, gate]
    if: \${{ !cancelled() && needs.plan.result == 'success' }}
    runs-on: ${RUNS_ON}
    timeout-minutes: 5
    steps:
${SETUP_STEPS}
      - run: bun install
      - uses: actions/download-artifact@v8
        with:
          pattern: verify-part-*
          path: \${{ runner.temp }}/parts
          merge-multiple: true
      - run: bun run verify merge "$RUNNER_TEMP"/parts/*.json
`;

/** The CI a new app is born with, in reading order: the gate, the image, the dependency updates. */
export function githubFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    { path: CI_WORKFLOW_PATH, contents: ci(app) },
    { path: IMAGE_WORKFLOW_PATH, contents: imageWorkflow(CI_WORKFLOW_NAME) },
    { path: DEPENDABOT_PATH, contents: dependabot() },
  ];
}
