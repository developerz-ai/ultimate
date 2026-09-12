// The human-authored half of what `x new` writes: the READMEs, the agent-facing convention files,
// the bin/ shims and the optional dev compose. Separated from the config half so neither file has
// to be scrolled to find the other — one file, one job applies to templates too. The image, its
// ignore file, the production topology and the deploy page are `scaffold-container.ts`; the
// `.claude/` harness that reads AGENTS.md is `scaffold-claude.ts`; the one workflow is
// `github/ci.yml.ts`.

import { LINE_CEILING } from '../workspace-checks';
import { githubFiles } from './github/ci.yml';
import type { GeneratedFile, NameSet } from './naming';
import { claudeFiles } from './scaffold-claude';
import { containerFiles } from './scaffold-container';

const agents = (app: NameSet): string => `# AGENTS.md

Human-authored, short, stable. Facts live in \`x.manifest.json\`; this file holds only what an
agent cannot infer from the code.

Every row below names what refuses it. A rule with nothing in the last column is a rule that does
not exist — five of these had an empty column and were each measured green on \`x verify\`.

| Rule | Detail | Refused by |
|---|---|---|
| One gate | \`bin/check\` — \`x build\` and then \`x verify\`. Green means shippable; never merge red. | the gate itself, and \`.github/workflows/ci.yml\` on every push and pull request |
| One way | generators, not hand-rolled files: \`x g resource\`, \`x g action\`, \`x g route\` | review |
| Surfaces | \`site/\` is 0kb JS and may not import \`app/\`; \`shared/\` is a leaf | \`X_BOUNDARY_SITE_TO_APP\` |
| Data | routes call actions and queries; only \`repo.ts\` touches the database | \`X_BOUNDARY_ROUTE_TO_DB\` |
| Errors | never \`throw new Error\` — subclass \`UltimateError\` with a code, a cause and a fix | \`guards/bare-error.ts\` |
| Money | \`{ minor, currency }\`, never a float — \`money()\` on the column | the type: \`price: 19.99\` is TS2322, \`number\` is not \`MoneyInput\` |
| Time | store UTC, format with an explicit IANA time zone | \`guards/unzoned-date.ts\` |
| Strings | every user-facing string goes through \`t()\` | \`guards/untranslated-string.ts\` |
| Colour | semantic tokens only, never a raw hex | \`guards/raw-colour.ts\` |
| Interaction | a click is answered by a control — never a \`<div onClick>\`, and never a \`role=\` where the native tag exists | \`guards/semantic-interactive.ts\` |
| Focus | \`outline: none\` replaces the ring in the same rule or the one beside it, or it does not remove it | \`guards/focus-visible.ts\` |
| Images | every image carries width + height or an aspect-ratio, and the priority one is never \`loading="lazy"\` | \`guards/image-dimensions.ts\` |
| Motion | animate \`transform\` and \`opacity\` — never a layout property, never \`transition: all\` | \`guards/animated-layout-property.ts\` |
| Islands | every \`*.island.tsx\` has a sibling \`*.island.states.ts\`, so \`x shot --island\` can photograph its failures | \`guards/island-without-states.ts\` |
| Size | one file, one job — ${LINE_CEILING} lines of reviewable logic, and split past it | \`X_FILE_TOO_LONG\` |

\`guards/\` is yours: each file is one rule, discovered by \`x verify\` and run inside its
\`boundaries\` step. Delete one to drop the rule, and \`x g guard <name>\` writes the next.

The last five rows are about what this app is like to USE, and each is decidable from the file
alone — which is why they are those five and not the many that are not. A role is a promise:
\`role="button"\` obliges you to answer Space, Enter, focus and disabled, and the native element
already does. Only \`transform\` and \`opacity\` animate without a layout pass. An image with no box
moves everything under it when its bytes land.

Size is a hard line and not a style note: past ${LINE_CEILING} lines a file has stopped being the
unit of review, and \`x verify\` refuses it. The one exemption is a file that is nothing but re-exports —
it has one job by construction, and its length tracks the API's size rather than its complexity;
one statement of logic in such a file re-arms the ceiling on the same save.

Money is the one row with no guard, deliberately: a float has no static signature a text rule can
see, and the type already fires — measured, \`price: 19.99\` in a seed is
\`TS2322: Type 'number' is not assignable to type 'MoneyInput'\`. A guard that pretended to check
it would be worse than the type that really does.

\`bin/check\` is the gate and \`x verify\` is only its second half: the first is
\`x build --target static\`, and the build is what writes the \`.x/build-stats.json\` the
\`budgets\` step measures. Run \`x verify\` on a tree nobody has built and \`budgets\` is red with
X_BUDGET_UNMEASURED — the gate reporting on a file that does not exist, not on your code.

The platform's \`.dz/\` is ADDITIVE, in both directions. developerz.ai keeps its own files under
\`.dz/maintainer/\` and \`.dz/pipeline/\`; nothing \`x new\` writes lands under \`.dz/\` and nothing
here is generated from it. So the scaffold never clobbers a maintainer policy, the platform never
clobbers \`AGENTS.md\`, \`bin/\`, \`.claude/\` or \`.github/\`, and deleting either side leaves the
other exactly as it was.

Commands: \`bin/setup\`, \`bin/dev\`, \`bin/check\`, \`x g <primitive>\`, \`x g guard <name>\`,
\`x db branch create <name>\`, \`x doctor\`.

Project notes for ${app.kebab}: replace this line with the conventions a newcomer could not guess.
`;

const claude = (app: NameSet): string => `# CLAUDE.md

${app.kebab} — Ultimate app. Read AGENTS.md first; it is the same content in the same order.

- Gate: \`bin/check\` (add \`--json\` for machine output — it reaches both halves). It is
  \`x build --target static\` and then \`x verify\`; \`x verify\` alone leaves \`budgets\` with
  nothing to measure. \`.github/workflows/ci.yml\` runs \`bin/setup && bin/check\` on every push
  and pull request, so CI and your terminal run the same two commands.
- \`.dz/\` belongs to the developerz.ai platform and is additive both ways: the scaffold writes
  nothing there, and nothing there is generated from this repo. Neither side clobbers the other.
- Scaffold, do not hand-write: \`x g <kind> <name>\` — \`x g --help\` lists every kind, and is the
  only place that list is stated.
- Destructive DB work goes in a branch: \`x db branch create <name>\`, never the shared dev DB.
- \`x doctor\` explains a broken environment and prints the fix command for every finding.

\`.claude/\` holds the harness that reads this file: \`/feature\`, \`/planx\`, \`/verify\` and four
boundary-scoped subagents. It is yours — \`.claude/README.md\` says what each one costs, and every
file in it is deletable.
`;

const readme = (app: NameSet): string => `# ${app.pascal}

Built with [Ultimate](https://github.com/developerz-ai/ultimate). Bun-only, Postgres, SolidJS.

## 🚀 Start

\`\`\`sh
bin/setup     # prerequisites, deps, env, the first migration, migrate, seed, the manifest
bin/dev       # all roles in one process, embedded Postgres, /_x mounted
bin/check     # the gate: a static build, then typecheck, lint, boundaries, tests, drift, budgets
\`\`\`

\`packages/db/migrations\` starts empty and \`x db gen\` is its only writer — \`bin/setup\` runs
\`x db gen "initial"\` for you on a fresh clone. Until it has, \`x verify\`'s \`drift\` step is red
with \`X_DB_DRIFT\`, and that is the fix it names.

## 🗺 Layout

| Path | Holds |
|---|---|
| \`apps/web/site\` | static/isr, 0kb JS, SEO-critical |
| \`apps/web/app\` | authed, streaming, realtime |
| \`apps/web/api\` | actions only |
| \`apps/web/shared\` | tokens, primitives, actor type — a leaf |
| \`apps/admin\` | generated admin dashboard, MCP on |
| \`packages/*\` | domain, db, i18n, ui, mcp |
| \`app.config.ts\` | the one config file |
| \`x.manifest.json\` | generated facts: routes, actions, jobs, policies |
| \`.github/workflows/ci.yml\` | \`bin/setup\` then \`bin/check\`, on push and pull request |
`;

const binSetup = (): string => `#!/usr/bin/env bash
# Fresh clone to running. Idempotent: safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v bun >/dev/null || { echo "X_BUN_MISSING: install bun — https://bun.sh"; exit 1; }
bun install
[ -f .env.development.local ] || printf '# per-box secrets, gitignored, wins over .env.development\\n' > .env.development.local
# \`x db gen\` is the ONE writer of packages/db/migrations — the scaffold no longer hand-writes a
# 0000_initial.sql, because a second writer is how the source and the ledger ended up disagreeing
# about what "initial" meant. Guarded on the directory rather than on the generator being a no-op:
# this script is documented idempotent, and the guard is what makes that true here.
ls packages/db/migrations/*.sql >/dev/null 2>&1 || bunx x db gen "initial"
bunx x db migrate "$@"
# \`x db seed\`, never \`bun run\`: the CLI owns the connection, so this reaches the same embedded
# PGlite the migration above just wrote to. A plain script goes through \`db()\`, which needs a
# \`postgres:\` DATABASE_URL and so dies on a clone with no Postgres — one line after reporting a
# successful migration.
bunx x db seed
# The file \`AGENTS.md\` line 3 tells an agent facts live in, and \`x dev\` prints the path of. It
# is a projection of the loaded app, so \`x new\` cannot write it — node_modules does not exist
# yet — and nothing else ever ran the command: after \`x new\`, \`bin/setup\` and all 13
# generators, \`find . -name '*.manifest.json'\` returned nothing while \`x verify\` reported
# \`\u2713 manifest\`. \`x verify\`'s manifest step now refuses its absence (X_MANIFEST_MISSING).
bunx x manifest
echo "setup complete — next: bin/dev"
`;

const binDev = (): string => `#!/usr/bin/env bash
# Every role in one process: embedded Postgres, in-process NATS, S3 to a local dir.
set -euo pipefail
cd "$(dirname "$0")/.."
exec bunx x dev "$@"
`;

const binCheck = (): string => `#!/usr/bin/env bash
# The gate. Same steps as CI, because a check that lives only in CI cannot be run locally.
set -euo pipefail
cd "$(dirname "$0")/.."
# The build FIRST, and not as a convenience: \`x verify\`'s budgets step compares declared limits
# against measured bytes in .x/build-stats.json, so with no build it reports X_BUDGET_UNMEASURED and
# the very first gate anyone runs on a brand-new app is red for a reason that has nothing to do with
# their code. Cheap on a warm tree, and it makes "green" reachable from a fresh clone.
#
# \`--json\` is forwarded to BOTH, or the contract breaks: \`bin/check --json\` would otherwise print
# the build's human renderer to stdout and then the gate's JSON, and a machine consumer reading one
# document off stdout gets neither. Both commands emit one object; a reader takes the last line.
build_flags=""
for arg in "$@"; do
  case "$arg" in --json|-j) build_flags="--json" ;; esac
done
bunx x build --target static $build_flags
exec bunx x verify "$@"
`;

const composeDev = (
  app: NameSet,
): string => `# Optional: x dev needs none of this. Use it when you want the real Postgres/NATS/MinIO locally.
#
# Every published port binds 127.0.0.1, not 0.0.0.0. This stack ships its credentials in the file,
# as a dev stack reasonably does — so the short form \`'5432:5432'\` would put an authenticated
# database and an open object store on every interface this machine has, including the café wifi.
# Docker publishes a port by writing DNAT rules, so a host firewall does not stop it. To reach this
# stack from another machine, put a tunnel in front of it (\`ssh -L\`) rather than widening the bind;
# production topology is docker-compose.prod.yml, and it is a different file for a reason.
services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_PASSWORD: ${app.kebab}
      POSTGRES_DB: ${app.kebab}
    ports: ['127.0.0.1:5432:5432']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres']
      interval: 5s
  nats:
    image: nats:2-alpine
    command: ['-js']
    ports: ['127.0.0.1:4222:4222']
  s3:
    image: minio/minio
    command: ['server', '/data']
    environment:
      MINIO_ROOT_USER: ${app.kebab}
      MINIO_ROOT_PASSWORD: ${app.kebab}-dev
    ports: ['127.0.0.1:9000:9000']
`;

/** Docs, shims and container files for a new app, in the order a reader meets them. */
export function docsFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    { path: 'README.md', contents: readme(app) },
    { path: 'AGENTS.md', contents: agents(app) },
    { path: 'CLAUDE.md', contents: claude(app) },
    { path: 'bin/setup', contents: binSetup() },
    { path: 'bin/dev', contents: binDev() },
    { path: 'bin/check', contents: binCheck() },
    { path: 'docker/docker-compose.dev.yml', contents: composeDev(app) },
    // The harness half of the same job AGENTS.md does. It lands in the app's own repo rather than
    // in a global config, so it is visible in the scaffold's diff and deletable in one line.
    ...claudeFiles(app),
    // The same two commands `README.md` opens with, run by a machine that has never seen this
    // repository. Registered here and not in `scaffold-repo.ts` because it is documentation of the
    // gate in executable form, which is the job this file has.
    ...githubFiles(app),
    ...containerFiles(app),
  ];
}

/** Files that must be executable after `x new` writes them. */
export const EXECUTABLE_FILES: readonly string[] = ['bin/setup', 'bin/dev', 'bin/check'];
