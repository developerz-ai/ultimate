# 13 — Every app shape gated, and the definition of finished

> Part of [`overview.md`](overview.md). Depends on: [`04`](04-auth-http.md), [`06`](06-ai-mail-scraping-ui.md), [`07`](07-gate-truth.md), [`08`](08-upgrade-without-hands.md). Tier: apps, docs.

## Files to change
- `packages/create-ultimate/` + `packages/cli/src/templates/` shapes — S1. `api`, `blog`, `dashboard` exist; `saas` and `agent` wait (`wiki/Shapes.md:59-61`; 2026/11/02 slice 42 at 70%).
- `.github/workflows/ci.yml` `scaffold-smoke` — gates two shapes today.
- `wiki/Shapes.md`, `wiki/Building-Your-Own-Base.md:27,67,181`, `wiki/Stability.md`, `wiki/Known-Gaps.md`.
- `docs/history/finished.md` (new), `README.md`, `llms.txt`.
- `docs/idea/14-roadmap.md:25,141-151` — desktop, mobile, OTA are design only; `x branch` planned.

## Steps
1. S1, shapes — each a scaffold that passes the strict gate ([`07`](07-gate-truth.md)) twice in `scaffold-smoke`:

| Shape | Proves | Uses |
|---|---|---|
| `saas` | tenants, invites, roles, billing as app code | `auth` invites ([`04`](04-auth-http.md)), `flags` for entitlements, meters, a `webhook-receiver` for a payment provider's events |
| `agent` | an LLM agent with tools and an MCP surface | `ai` with fallback ([`06`](06-ai-mail-scraping-ui.md)), `mcp`, `jobs`; the model named by environment only |
| `realtime` | multi-user live state across two nodes | `realtime` multi-node ([`05`](05-jobs-realtime.md) R1), `notify` |
| `content` | a static site, 0 kB JS on `site/` | `seo`, `i18n`; `dummy/docs-site` is the proof, the shape is its scaffold |
| `offline` | an installable app that works with no network, on a LAN origin | `pwa`, `x dev --host --tls` ([`07`](07-gate-truth.md) G5) |

2. Billing is **not** a package (axiom 8). The `saas` shape's billing is ~3 app files wrapping primitives; `wiki/Building-Your-Own-Base.md` gains it as a recipe beside PDF assembly, a PIN authenticator and a named proxy pool — each a wrap, each compiled and run by `tutorial-run.yml`.
3. Roadmap truth: move desktop, mobile, OTA and `x branch` out of `docs/idea/14-roadmap.md`'s milestones into `wiki/Known-Gaps.md` as "not planned; the extension point is X". Finished means the list of intended work is empty, not that every idea was built.
4. `docs/history/finished.md` + the `wiki/Stability.md` section "maintenance mode": what still changes (reports, security, runtime upgrades, one major a window at most), what does not (new primitives, new packages without an outside report behind them), and who acts (the maintainer; no person on the path).
5. The finished table, each row a command, checked by a new `scripts/finished.ts --check --json` that the `health` brief runs weekly:

| Fact | Command |
|---|---|
| no stub | `grep` for non-test `NotImplementedError` outside Known-Gaps rows → 0 |
| no planned command | `cmd-planned.ts` registry empty |
| every shape gates | `scaffold-smoke` green for all shapes |
| the gate is whole | the three tracked apps run 21 of 21 steps, `expectedRed` empty |
| no exemption debt | every pin table empty or reasoned |
| tests are deterministic | 7 nights of `flake-hunt` |
| supported range is tested | `compat.yml` last run green |
| lanes exist | `next`, `release/<prev>.x`, `maint-<prev>` |
| one ledger | one `in_progress` tracker at most; Known-Gaps rows all carry a decision |
| loop is closed | last release cut by the maintainer; last main-red repaired by it |

## Tests
- `bun test ./scripts/finished.test.ts` — each row red on a fixture.
- `scaffold-smoke` per shape; `tutorial-run.yml` for the recipes.

## Done when
- `bun run scripts/finished.ts --check` is green on `main`.
- `README.md` and `wiki/Stability.md` state maintenance mode with the date.
