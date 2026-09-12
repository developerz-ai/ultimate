// The CI half of what `x new` writes: one workflow that runs the app's OWN two commands.
//
// Nothing under `templates/` emitted `.github` until this file, so every scaffolded app started
// life with a gate that ran on exactly one machine — the author's. The two commands are `bin/setup`
// and `bin/check` and NOT a restatement of their steps: a workflow that spelled out `bun install`,
// `x db migrate`, `x build` and `x verify` is a second definition of the gate, free to drift from
// the scripts a human runs, and axiom 1 has one way to do each thing. `bin/check` is also not a
// synonym for `x verify` — it BUILDS first, and the build is what makes the gate's `budgets` step
// measurable rather than X_BUDGET_UNMEASURED.

import { REQUIRED_BUN } from '../../app-root';
import type { GeneratedFile, NameSet } from '../naming';

/** Where the workflow lands. GitHub reads this path and no other. */
export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';

/**
 * Pinned by commit SHA with the version in the trailing comment, because this step runs before any
 * code of yours does and `@v2` is a tag its owner can move. `actions/*` follows its major tag
 * instead: GitHub owns the runner and the tag together. Same rule the framework's own
 * `.github/actions/setup/action.yml` states, and the same SHA.
 */
const SETUP_BUN = 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0';

const ci = (app: NameSet): string => `name: ci

# The gate for ${app.kebab}: the same two commands \`README.md\` tells a human to run, in the same
# order, on a machine that has never seen this repository. A check that exists only in CI is one
# nobody can reproduce locally, and a CI file that restates the gate's steps is a second gate.
#
# \`bin/check\` is \`x build --target static\` and THEN \`x verify\`. The build is not a convenience:
# the gate's \`budgets\` step compares declared limits against measured bytes in
# \`.x/build-stats.json\`, so a run with no build reports X_BUDGET_UNMEASURED. Run \`x verify\` here
# instead and this workflow is red for a reason that has nothing to do with the commit.
#
# No \`services:\` block, deliberately — \`bin/setup\` brings up embedded Postgres in-process, so
# there is nothing to provision and nothing to wait on. Add one the day this app needs a real
# server, beside the \`DATABASE_URL\` that selects it.

# EVERY push, not just the default branch's. \`x new\` runs a plain \`git init\` and takes whatever
# \`init.defaultBranch\` this machine already agreed on, so a \`branches: [main]\` filter silently
# runs nothing on a repository whose branch is called something else — and \`CLAUDE.md\` promises a
# run on every push, which a filter would make untrue for the app that read it.
on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    # A bound on a HANG, not on cost: a step that never returns holds a runner until GitHub's
    # six-hour default expires, and the failure is invisible for all six of them.
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
      - uses: ${SETUP_BUN}
        with:
          # \`package.json\`'s \`engines.bun\` floor, exactly — the OLDEST runtime this app declares
          # it supports, so a call that needs a newer Bun fails here rather than in the install of
          # whoever took the app at its word. Never \`latest\`: a Bun minor landing unannounced is a
          # runtime change nobody chose.
          bun-version: '${REQUIRED_BUN}'
      # Two steps rather than one \`&&\`, so the log names which half failed and times each.
      - run: bin/setup
      - run: bin/check
`;

/** The CI a new app is born with, in the order a reader meets it. */
export function githubFiles(app: NameSet): readonly GeneratedFile[] {
  return [{ path: CI_WORKFLOW_PATH, contents: ci(app) }];
}
