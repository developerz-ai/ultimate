# 42 — Adoption: any vendor's coding agent, cold

> Part of [`overview.md`](overview.md). Depends on: [`32-docs-findability`](32-docs-findability.md) and [`36-dx-generators`](36-dx-generators.md), which also edit `scaffold-docs.ts`; land after both. OAuth on the app endpoint stays [`41-add-identity`](41-add-identity.md). Tier: 5 (`cli`), docs.

## Why
The promise is "the primary developer is an AI agent", not one vendor's. Read as such an agent, in a fresh 29.4.0 scaffold, 2026-11-02:

| Agent meets | As run | Cost |
|---|---|---|
| `x g <primitive>`, `x doctor` (`cli/src/templates/scaffold-docs.ts:106`), `Bash(x verify:*)` (`.claude/settings.json`) | `command -v x`: none. Generators print `bunx x`, docs print `x` | first command fails, agent guesses; a wrong guess runs someone else's package ([`42-adopt-first-hour`](42-adopt-first-hour.md) F3) |
| MCP | `x mcp serve` works: `tools/list` over stdio returned 18 tools. No `.mcp.json`; `grep -i mcp AGENTS.md`: 0 hits; `README.md` two layout rows | dev tools exist and no agent finds them |
| the headline artifact, "an MCP tool" | `app.config.ts:82` has `ai.mcp.expose: true`, `health` has `mcp: { expose: true }`, yet `POST /mcp` is 404 in dev **and** in the production image, and every boot logs `X_MCP_APP_UNMOUNTED`. `scaffold-mcp-package.ts:58-62` builds `defineAppMcp` with no `resolveToken`, so no `route` | the first warning a stranger reads says a README claim is off |
| vendor text | `scaffold-docs.ts:100,121`: paragraphs on a hosting platform's `.dz/` directory, in every stranger's `AGENTS.md` and `CLAUDE.md`, pinned by `scaffold-docs.test.ts:74` | context spent on a product they never chose |
| workflows | `/feature`, `/planx`, `/verify` under `.claude/commands/` only; `AGENTS.md` never names them | one vendor gets the loop; others do not know it exists |
| `llms.txt` | `README.md:24` sends every agent there. Its first block (`llms.txt:7-14`) is `bun run scripts/…`, absent from an app | an app's agent runs commands that do not exist |
| `wiki/Installation.md:159` | "Thirteen tools"; `x mcp tools` says 18 | a count the agent will quote |

## Decisions
| Question | Answer |
|---|---|
| Per-vendor rule directories | none. `AGENTS.md` is the cross-vendor file, `.claude/` stays deletable. A second vendor directory is a second copy to drift |
| Moving `.claude/commands/` | no. They are plain markdown; `AGENTS.md` names them as procedures any agent can read |
| Client config | one `.mcp.json`, the format several clients read: `bunx @ultimat3/cli mcp serve --transport stdio`, never `bunx x`: a client may spawn it outside the installed app, where `bunx x` fetches an unrelated npm package ([`42-adopt-first-hour`](42-adopt-first-hour.md) F3). A client that wants another file is told how in `wiki/MCP-And-AI.md`, not generated for |
| Canonical shell spelling in an app | `bunx x …`, matching what generators already print. `.mcp.json` alone differs, above |
| Scaffold `POST /mcp` | mounted and refusing: `apps/web/mcp.ts` with `resolveToken` from the app's authenticator. A request without a token is 401. Dev-only tokens never reach production |
| `llms.txt` scope | this slice covers the repo's root file only: it leads with the app author's block. A site's served `/llms.txt` is [`41-add-locale-and-content`](41-add-locale-and-content.md)'s. No repo-root file in an app: `AGENTS.md` + `x.manifest.json` + `x docs` already answer |
| `.dz/` text | out of the scaffold. `.dz/` stays in this repo |
| "Works with every agent" | never claimed. The claim is what is tested below |

## Files to change
- `packages/cli/src/templates/scaffold-docs.ts:100,106,121` + `scaffold-docs.test.ts:74` — spelling, `.dz/` out, an "Agent tools" block: `.mcp.json`, `x.manifest.json`, the workflow files.
- `packages/cli/src/templates/scaffold-claude.ts`, `scaffold-claude-commands.ts`, test — `Bash(bunx x …)` allow entries beside or replacing the bare form.
- `packages/cli/src/templates/` new `scaffold-mcp-json.ts` + test — `.mcp.json`.
- `packages/cli/src/templates/scaffold-mcp-package.ts:58-62` + test — the mounted endpoint; `resolveToken`.
- `scripts/generator-counts.ts` — file count moves; `README.md:44` gets the new figure from [`42-adopt-front-door`](42-adopt-front-door.md).
- `scripts/llms-txt.ts`, `llms.txt`, `scripts/llms-txt.test.ts` — app block first, framework block under its own heading.
- `.github/workflows/ci.yml` scaffold-smoke, `scripts/scaffold-gate.ts` — the cold-start step.
- `wiki/Agents.md`, `wiki/MCP-And-AI.md`, `wiki/Installation.md:146-175`, `packages/mcp/README.md:137`.

## Steps
1. `scaffold-docs.ts`: replace bare `x` in commands with `bunx x`; delete both `.dz/` paragraphs; add the "Agent tools" block. Size stays within the `AGENTS.md` budget (`@ultimat3/manifest`).
2. Write `.mcp.json`. Prove it: smoke spawns the file's own command, sends `initialize` and `tools/list`, asserts non-empty.
3. Mount the app endpoint. `POST /mcp` without a token: 401. The boot log says `app mcp mounted`, not `X_MCP_APP_UNMOUNTED`. Smoke with a dev token: `health` is listed and callable.
4. `AGENTS.md` conformance: every backticked command resolves against the `x` registry or a `package.json` script of the scaffold, and no text names a vendor other than the literal `.claude/` path.
5. Restructure `llms.txt`: "Building an app" (`bunx create-ultimate`, `bunx x …`, wiki) first; "Working on this repository" second. `bun run llms-txt --write`.
6. Replace "Thirteen tools" with `x mcp tools --json`.
7. Prepared, owner-run once per major: a cold-start prompt in `wiki/Agents.md` ("add a notes feature, make the gate green") for any agent, with what to record: commands before first green, wrong guesses. Results stay out of the repo unless a vendor-neutral table is wanted.

## Error codes
Existing: `X_MCP_APP_UNMOUNTED` stays for an app that deletes the file. New: none.

## Tests
- `scaffold-docs.test.ts`: fails on a bare `x g`, on `.dz/`, on a vendor name; asserts `.mcp.json` is mentioned.
- `scaffold-mcp-json.test.ts`: the command is `bunx @ultimat3/cli`; fails on `bunx x`.
- `scaffold-mcp-package` test: `mcp.route` defined; 401 without a token.
- Scaffold smoke (CI): `.mcp.json` handshake; `POST /mcp` 401; boot log free of `X_MCP_APP_UNMOUNTED`.
- `scripts/llms-txt.test.ts`: the first section holds no `bun run scripts/`.
- `bun test packages/cli/src/templates/scaffold-docs.test.ts`

## Semver
Minor. Scaffold-only; existing apps keep their files. `x doctor` is unchanged.

## Done when
- A fresh scaffold's `AGENTS.md` commands all run as written in a shell with no global `x`.
- `.mcp.json` handshake and app `POST /mcp` are asserted on every push; `x dev` logs no warning on a new app.
- `git grep -n 'developerz.ai\|\.dz/' packages/cli/src/templates/scaffold-docs.ts` holds only the repository link.
