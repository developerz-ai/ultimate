// The human-authored half of what `x new` writes: the READMEs, the agent-facing convention files,
// the bin/ shims and the docker directory. Separated from the config half so neither file has to
// be scrolled to find the other — one file, one job applies to templates too.

import type { GeneratedFile, NameSet } from './naming';

const agents = (app: NameSet): string => `# AGENTS.md

Human-authored, short, stable. Facts live in \`x.manifest.json\`; this file holds only what an
agent cannot infer from the code.

| Rule | Detail |
|---|---|
| One gate | \`x verify\` — green means shippable. Never merge red. |
| One way | generators, not hand-rolled files: \`x g resource\`, \`x g action\`, \`x g route\` |
| Surfaces | \`site/\` is 0kb JS and may not import \`app/\`; \`shared/\` is a leaf |
| Data | routes call actions and queries; only \`repo.ts\` touches the database |
| Errors | never \`throw new Error\` — subclass \`UltimateError\` with a code, a cause and a fix |
| Money | integer minor units + ISO code, never a float |
| Time | store UTC, format with an explicit IANA time zone |
| Strings | every user-facing string goes through \`t()\` |
| Colour | semantic tokens only, never a raw hex |

Commands: \`x dev\`, \`x verify\`, \`x g <primitive>\`, \`x db branch <name>\`, \`x doctor\`.

Project notes for ${app.kebab}: replace this line with the conventions a newcomer could not guess.
`;

const claude = (app: NameSet): string => `# CLAUDE.md

${app.kebab} — Ultimate app. Read AGENTS.md first; it is the same content in the same order.

- Gate: \`x verify\` (add \`--json\` for machine output).
- Scaffold, do not hand-write: \`x g resource|action|job|route|policy|entity|query|task\`.
- Destructive DB work goes in a branch: \`x db branch <name>\`, never the shared dev DB.
- \`x doctor\` explains a broken environment and prints the fix command for every finding.
`;

const readme = (app: NameSet): string => `# ${app.pascal}

Built with [Ultimate](https://ultimate.dev). Bun-only, Postgres, SolidJS.

## 🚀 Start

\`\`\`sh
bin/setup     # prerequisites, deps, env, migrate, seed
x dev         # all roles in one process, embedded Postgres, /_x mounted
x verify      # the gate: typecheck, lint, boundaries, tests, drift, budgets
\`\`\`

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
bunx x db migrate "$@"
bun run db:seed
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
exec bunx x verify "$@"
`;

const composeDev = (
  app: NameSet,
): string => `# Optional: x dev needs none of this. Use it when you want the real Postgres/NATS/MinIO locally.
services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_PASSWORD: ${app.kebab}
      POSTGRES_DB: ${app.kebab}
    ports: ['5432:5432']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres']
      interval: 5s
  nats:
    image: nats:2-alpine
    command: ['-js']
    ports: ['4222:4222']
  s3:
    image: minio/minio
    command: ['server', '/data']
    environment:
      MINIO_ROOT_USER: ${app.kebab}
      MINIO_ROOT_PASSWORD: ${app.kebab}-dev
    ports: ['9000:9000']
`;

const dockerfile = (
  app: NameSet,
): string => `# One image, all roles. ROLE selects behaviour at start; nothing else differs between processes.
FROM oven/bun:1.3-alpine AS deps
WORKDIR /src
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-alpine AS build
WORKDIR /src
COPY --from=deps /src/node_modules ./node_modules
COPY . .
RUN bunx x build --target binary --out /out/${app.kebab}

FROM gcr.io/distroless/base-debian12 AS runtime
COPY --from=build /out/${app.kebab} /app/${app.kebab}
ENV ROLE=web PORT=3000
EXPOSE 3000
USER 65532:65532
ENTRYPOINT ["/app/${app.kebab}"]
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
    { path: 'docker/Dockerfile', contents: dockerfile(app) },
    { path: 'docker/docker-compose.dev.yml', contents: composeDev(app) },
  ];
}

/** Files that must be executable after `x new` writes them. */
export const EXECUTABLE_FILES: readonly string[] = ['bin/setup', 'bin/dev', 'bin/check'];
