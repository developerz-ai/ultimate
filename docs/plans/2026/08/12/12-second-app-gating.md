# 12 — Second app gating decision

## Context

`dummy/social-media-clone` is a deployed demo app (published by `.github/workflows/deploy-social-demo.yml` on every push to main). It shipped 237 tracked files with zero build gates, test support, or verification infrastructure until 2026-08. Prior to this plan, it was unclear whether the app should be:
- **Deleted** (remove the demo entirely), or
- **Gated** (bring it into the framework's verification ratchet like `examples/dummy`)

## Decision

**Gate it on its own ratchet, not the reference app's ratchet.**

### Rationale

Per axiom 3 ("Enforced, not documented"), *a claim that is not a build error does not exist.* An image this repo ships to a live URL is a claim. Removing the claim without removing the image is false — the repo still owns the deployed artifact, so it owns the gates that assert the artifact works. Deleting the code without turning off the deploy is worse than keeping both.

Instead, gate the app on its own ratchet with a different expectations table than the reference app — `scripts/lib/gated-apps.ts` holds both `examples/dummy` (curated reference) and `dummy/social-media-clone` (demo).

### Gating strategy

Each tracked app has:
- A separate `expectedRed` table in `GATED_APPS` (the pins unique to that app)
- A separate ratchet discipline: steps pinned today must stay pinned until fixed; steps that go green must be unpinned immediately
- A shared runner (`scripts/reference-app-gate.ts`) that gates both from one command

The app entered the ratchet at 3 red of 17 and sits at **2 red of 17** `As of 2026-08` — `typecheck` came off the pin once `AdminRepo`'s id was rebranded — not because it is the reference app (it is not), but because its genuine bugs surface in the gate:
- **`boundaries` (×3 violations)** — static feed (`site/feed/page.tsx`) imports app-layer service code (`app/posts/service.ts`), dragging policy and repo with it across the static/app boundary
- **`drift`** — migrations predate the current entity set; need regeneration (`x db gen`)

All other 15 steps must pass: typecheck ✓, lint ✓, contract ✓, live ✓, job ✓, e2e ✓, and the rest are already clean. The live table is `GATED_APPS`, not this paragraph.

### Migration work completed

1. **Migrated repo API usage to the real entity surface** (`e89640c`) — rebranded `AdminRepo`'s id parameter from bare `string` to `IdOf<Row>`, fixing 4 typecheck errors caused by the phantom API mismatch
2. **Wired the app into the gate** (`182c666`) — updated `scripts/reference-app-gate.ts` to run both apps, each with its own expectations table
3. **Updated `CLAUDE.md` layout** — documented the second app and clarified the two-app structure

## Outcome

The gate now enforces, `As of 2026-08`:
- `examples/dummy` stays green on 11/17 steps (6 pinned: typecheck, contract, live, job, e2e, drift — all data-substrate)
- `dummy/social-media-clone` stays green on 15/17 steps (2 pinned: boundaries, drift). No pin is implied by the other app — each table stands alone
- Each fix lands as a line deletion from the corresponding `expectedRed` table (`bun run scripts/reference-app-gate.ts --unpin <app>:<step>`)
- No second path: one `x verify` runs both, one ratchet discipline, one manifest

## "What is `dummy/`?"

For CLAUDE.md clarity: `dummy/social-media-clone` is the **deployed demo app** — a second tracked app shipped as a production container image, gated separately from the primary **reference app** (`examples/dummy`). Both teach primitives and exercise the framework, but the demo's gate is independent: steps pinned in `examples/dummy` do not block the demo from shipping, and vice versa.
