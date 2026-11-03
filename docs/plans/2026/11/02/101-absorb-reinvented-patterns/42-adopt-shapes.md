# 42 — Adoption: starters for the common app shapes

> Part of [`overview.md`](overview.md). Depends on: [`36-dx-generators`](36-dx-generators.md). Per shape: `saas` on [`25-pkg-auth-sign-in`](25-pkg-auth-sign-in.md), [`14`](14-jobs-inbound-webhooks.md); `dashboard` on [`23-ui-data-table`](23-ui-data-table.md); `agent` on [`01`](01-ai-tool-gate.md), [`18`](18-ai-scripted-and-meter.md). Tier: 5 (`cli`), CI.

## Why
`x new` has one shape, plus `--no-example` (`cli/src/cmd-new.ts`, `x help new`). A stranger with a blog, an API or an AI agent in mind gets a posts-and-dashboard example and must work out what to delete. `examples/dummy` is the reference, "every primitive, once" (`examples/dummy/README.md:3`), a poor starting point by design. A stranger's agent deletes badly: generators are additive, and 36 shows what hand-edits do to the gate.

## Decisions
| Question | Answer |
|---|---|
| Mechanism | `x new <name> --shape <shape>`: a flag on the existing command, default today's output. Still zero questions |
| Where they live | `packages/cli/src/templates/shapes/<shape>.ts`, overlays over the same scaffold, same as `--no-example`'s branch |
| Published packages, git fetch, `--from <url>` | no. Each adds a network path and a trust question to first run. Third-party starters are a repository a person copies, [`42-adopt-outsiders`](42-adopt-outsiders.md) |
| Per-shape tracked apps | no: `scaffold-smoke` gates each at no extra upkeep |
| Business conventions | none (axiom 8). Generated code is the app's from birth. No plans, tiers, quotas, prices, provider or provider SDK |
| Count | five. A sixth needs an adopter asking |
| Guards, gate, deploy | identical. No shape waives a step, and each is 95% coverage on arrival |

## The shapes
| Shape | Writes | Leaves out | Blocked by |
|---|---|---|---|
| `blog` | `site/` only: `post` entity, static + isr routes, feed, sitemap, a seed | `app/`, islands, sync role | none |
| `api` | `api/` actions and queries, API-key auth, OpenAPI, MCP mounted | `site/` pages beyond errors, islands, UI | none |
| `dashboard` | `app/` table + detail, live refresh, sign-in, one job, admin | marketing `site/` beyond a home | 23-ui-data-table, 25-sign-in |
| `saas` | tenancy on, sign-in, member invite, per-org policy, **billing seam**: a `webhookReceiver()` route with a signature verifier the app supplies, an append-only `billing_events` entity, and `shared/entitlements.ts` exporting one app-owned function that `policy` calls, returning `false` with a comment saying the rule is yours | plan names, tiers, quotas, pricing page, any payment provider | 14, 25-sign-in |
| `agent` | `llm()` action, `task` + `job` loop, tool gate, MCP, scripted model for tests and evals, an env var for model and key, no model id pinned in code | `site/` beyond a home | 01, 18 |

## Files to change
- `packages/cli/src/templates/shapes/{blog,api,dashboard,saas,agent}.ts` (new) + `.test.ts`.
- `packages/cli/src/cmd-new.ts`, its spec — flag, validation, `--no-example` conflict.
- `packages/create-ultimate/src/index.ts`, `README.md` — passes through; no code path of its own.
- `scripts/generator-counts.ts` — per-shape counts.
- `.github/workflows/ci.yml` `scaffold-smoke` matrix, `scripts/ci-workflow-shape.test.ts`, `scripts/scaffold-gate.ts`.
- `wiki/CLI-Reference.md`, `wiki/Installation.md`, `wiki/Getting-Started.md`, `packages/cli/README.md`, `README.md` — one table.
- `wiki/Shapes.md` (new), `wiki/_Sidebar.md` — what each writes and leaves out.

## Steps
1. Add the flag and `blog`; extend the smoke matrix with `{ app: blogapp, flags: --shape blog }`. Each row gates twice, like `demoapp`, `bareapp`.
2. `api`. Decide in the PR whether `site/errors` stays required; prefer yes, a stranger's API still answers a 404 page.
3. `dashboard`, `saas`, `agent` once their blockers land; a shape whose slice has not landed stays unregistered, never `X_NOT_IMPLEMENTED`.
4. `saas` billing seam test proves the seam: a signed fixture event writes one `billing_events` row, and flipping `entitlements.ts` changes a policy verdict. No provider is named anywhere in the output.
5. `agent` passes the gate with no key and no network: scripted model, sealed fetch.
6. A shape's `README.md` says what to do next in three commands; its `AGENTS.md` adds at most one line, naming the shape.
7. Each smoke row's per-step times land in the job log, as `scaffold-gate.ts` prints already; CI stays one runner per unit, free.

## Error codes
`bun run new-error-code`, `--off-socket`.

| Code | When | Fix |
|---|---|---|
| `X_NEW_SHAPE_UNKNOWN` | `--shape` names no registered shape | `bunx @ultimat3/cli help new` lists them |
| `X_NEW_SHAPE_CONFLICT` | `--shape` with `--no-example` | drop `--no-example`: a shape is its own example |

## Tests
- Unit per shape: file set, no literal plan or provider name (a banned-word list inside the test), no `X_NOT_IMPLEMENTED`.
- CI smoke: `bun run setup && bun run check` green first pass, twice, with the generator sweep over each.
- `saas` seam and `agent` no-key as generated tests inside the scaffold, so a stranger keeps them.
- `bun test packages/cli/src/templates/shapes/blog.test.ts`

## Semver
Minor. A new flag; default output byte-identical (pinned by the existing scaffold tests).

## Done when
- Each registered shape is a row in `scaffold-smoke`, green twice.
- `bunx create-ultimate myblog --shape blog` ships 0 KB JS on every route; `--shape api` has no island.
- Grep of generated `saas`: no plan, tier, quota or provider word; `git grep` of `shapes/` agrees.
- `wiki/Shapes.md` is linked from the README's run section.
