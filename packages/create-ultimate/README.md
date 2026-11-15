# create-ultimate

Scaffold an Ultimate app — the monorepo, a seeded database and a green gate — with one command.

```sh
bunx create-ultimate myapp && cd myapp && bun run setup && bun run dev
```

Guide: [Getting started](https://github.com/developerz-ai/ultimate/wiki/Getting-Started).

`bun run setup` is the scaffold's own script (`bin/setup.ts`, run by Bun — the same command in
PowerShell, cmd and bash) and it is not optional: `x new` writes files and installs nothing, so
`x dev` on the tree it just wrote fails with `X_BUILD_FAILED`. The script installs the dependencies, writes `.env.development.local`, generates and applies the first migration, seeds,
and writes `x.manifest.json` — six commands, idempotent, so it is safe to re-run after every pull.

Thin wrapper over `x new` — same templates, same flags, no second code path.

| Flag | Does |
|---|---|
| `--dir <path>` | parent directory (default: cwd) |
| `--shape <shape>` | start from an app shape — `api`, `blog` ([Shapes](https://github.com/developerz-ai/ultimate/wiki/Shapes)); never with `--no-example` |
| `--no-example` | skip the example feature slice |
| `--no-git` | leave a bare directory; do not `git init` and commit |
| `--dry-run` | print the file list, write nothing |
| `--force` | write into a directory that already exists |
| `--json` | machine-readable output |

## Opening a repro bundle

```sh
bunx create-ultimate repro bundle-req1.json --framework ../ultimate
```

A bug's `x repro <id> --bundle` file, opened into a scratch app `repro-<id>/`: the `x new` scaffold
(no example slice), the reproducer under `repro/` importing the scratch app's db package, the bundle
as `repro/bundle.json`. With a framework checkout — `--framework <path>`, or the one cwd is inside —
every `@ultimat3/*` is a `file:` override onto its source. `repro` with no file is still an app named
`repro`. A file that is no `x-repro-bundle/1` bundle is `X_REPRO_BUNDLE_INVALID`; a directory that exists is `X_CLI_BAD_FLAG`.
It takes `--dir` (the parent, default cwd), `--framework` (the checkout to link; none found → the
registry) and `--json` — kept out of the table above, which is `x new`'s flags and nothing else.

What you get: `apps/web/{site,app,api,shared}`, `apps/admin` with MCP on, `apps/{mobile,desktop}`
placeholders, `packages/{domain,db,i18n,ui,mcp}`, `bin/`, `docker/`, `app.config.ts` — a landing
page at 0kb JS, a streaming authed dashboard, a seeded database and `x verify` green.
