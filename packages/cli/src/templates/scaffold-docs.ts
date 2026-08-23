// The human-authored half of what `x new` writes: the READMEs, the agent-facing convention files,
// the bin/ shims and the optional dev compose. Separated from the config half so neither file has
// to be scrolled to find the other — one file, one job applies to templates too. The image, its
// ignore file, the production topology and the deploy page are `scaffold-container.ts`; the
// `.claude/` harness that reads AGENTS.md is `scaffold-claude.ts`.

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
| One gate | \`x verify\` — green means shippable. Never merge red. | the gate itself |
| One way | generators, not hand-rolled files: \`x g resource\`, \`x g action\`, \`x g route\` | review |
| Surfaces | \`site/\` is 0kb JS and may not import \`app/\`; \`shared/\` is a leaf | \`X_BOUNDARY_SITE_TO_APP\` |
| Data | routes call actions and queries; only \`repo.ts\` touches the database | \`X_BOUNDARY_ROUTE_TO_DB\` |
| Errors | never \`throw new Error\` — subclass \`UltimateError\` with a code, a cause and a fix | \`guards/bare-error.ts\` |
| Money | \`{ minor, currency }\`, never a float — \`money()\` on the column | the type: \`price: 19.99\` is TS2322, \`number\` is not \`MoneyInput\` |
| Time | store UTC, format with an explicit IANA time zone | \`guards/unzoned-date.ts\` |
| Strings | every user-facing string goes through \`t()\` | \`guards/untranslated-string.ts\` |
| Colour | semantic tokens only, never a raw hex | \`guards/raw-colour.ts\` |

\`guards/\` is yours: each file is one rule, discovered by \`x verify\` and run inside its
\`boundaries\` step. Delete one to drop the rule, and \`x g guard <name>\` writes the next.

Money is the one row with no guard, deliberately: a float has no static signature a text rule can
see, and the type already fires — measured, \`price: 19.99\` in a seed is
\`TS2322: Type 'number' is not assignable to type 'MoneyInput'\`. A guard that pretended to check
it would be worse than the type that really does.

Commands: \`x dev\`, \`x verify\`, \`x g <primitive>\`, \`x g guard <name>\`, \`x db branch create <name>\`, \`x doctor\`.

Project notes for ${app.kebab}: replace this line with the conventions a newcomer could not guess.
`;

const claude = (app: NameSet): string => `# CLAUDE.md

${app.kebab} — Ultimate app. Read AGENTS.md first; it is the same content in the same order.

- Gate: \`x verify\` (add \`--json\` for machine output).
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
bin/setup     # prerequisites, deps, env, the first migration, migrate, seed
x dev         # all roles in one process, embedded Postgres, /_x mounted
x verify      # the gate: typecheck, lint, boundaries, tests, drift, budgets
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
echo "setup complete — next: x dev"
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
    ...containerFiles(app),
  ];
}

/** Files that must be executable after `x new` writes them. */
export const EXECUTABLE_FILES: readonly string[] = ['bin/setup', 'bin/dev', 'bin/check'];
