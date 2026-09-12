# The range

**One framework from a homework assignment to a very large product.** The small end pays nothing for
the large end — the large end is configuration the small end never types. The large end is reachable
because nothing the small end did has to be undone.

Not two products and not a "lite mode": [axiom 1](./00-thesis.md#design-axioms) forbids the second
path a lite mode would be. There is one scaffold, one gate, one set of primitives, and the defaults
*are* the small end.

| Size | You run | You decide | The framework already decided |
|---|---|---|---|
| a homework assignment, a weekend idea | `x dev` — one process, embedded Postgres, no Docker | your entities, your routes | everything in the measured table below |
| a real product with paying users | rung 0–1 of the [scale ladder](./17-scale-ladder.md): one PaaS instance, managed Postgres | when a signal says to split a role | the same |
| a very large product, many teams | rung 3–4: Kubernetes, per-role HPAs, your own drivers ([`20-large-app-readiness.md`](./20-large-app-readiness.md)) | which of your infrastructure to plug in | the same |

The app code is identical across those rows. That claim is [`17-scale-ladder.md`](./17-scale-ladder.md)'s
to defend, rung by rung, and it names where the invariant breaks today rather than softening it.

## Not overkill at the small end

Measured on a scaffold written by this checkout, `As of 2026-08-23`. Re-derive:
`bun run x -- new probe --dir /tmp --json`, then `cd /tmp/probe && ./bin/setup && x dev --once --json`.

| The small end's cost | Measured |
|---|---|
| questions asked | **0** — all five of `x new`'s flags carry a default (`bun run x -- help new`) |
| infrastructure to install first | **none** — no Docker daemon, no Postgres, no Redis, no NATS |
| env values to supply before the first boot | **0** — `.env.development` ships committed non-secret defaults, and an empty `DATABASE_URL` means embedded PGlite |
| files you write before the first page | **0 of 151** — re-derived `As of 2026-09-11`; `scripts/generator-counts.ts` turns a stale count red on the commit that moves it |
| commands from nothing to a running app | **4** |
| packages installed | **104**, in the one `bun install` `bin/setup` runs |
| `bin/setup` wall time, warm cache | **6,802ms** for all six steps, `As of 2026-09-11` — install, the env file, generate the first migration, apply it, seed, write the manifest. A **cold** first install takes it to 12.0s ([Bare VM](../../wiki/Bare-VM.md)) |
| what `x dev` starts | 4 roles in one process (`web` `sync` `worker` `scheduler`), 11 `/_x` panels, `db=embedded events=embedded storage=embedded mail=embedded` |

The four commands, and they are the whole of it:

```sh
bunx create-ultimate myapp
cd myapp
bin/setup     # bun install · .env.development.local · x db gen "initial" · x db migrate · x db seed · x manifest
x dev
```

**`bin/setup` is not optional.** `bunx create-ultimate myapp && cd myapp && x dev` was the form every
entry page carried until 2026-08-23, and it does not work: `x new` writes files and installs nothing,
so the app has no `node_modules`, no `x` binary of its own, and `x dev` stops at `X_BUILD_FAILED` —
*"Could not resolve `@ultimat3/ui`. Maybe you need to `bun install`?"* (measured). The scaffold's own
`README.md` and the `next:` line `x new` prints have always said `bun install` first, which is what
makes this a documentation defect rather than a code one. Re-derive with
`grep -rn 'cd myapp && x dev' --include='*.md' .`

### The gate a beginner inherits

The same 20 steps run in a scaffolded app and in this repo — `VERIFY_STEP_NAMES`
([`packages/cli/src/verify-step.ts:16`](../../packages/cli/src/verify-step.ts)), whole or not at all.
On the scaffold above, `As of 2026-08-23`:

| Run | Result |
|---|---|
| `bin/setup && bin/check` on a fresh scaffold | the gate green on the **first** pass, **20 of 20 steps** with `budgets` among them. Measured on a WSL2 developer box — not a VM, not a CI runner — warm cache, `As of 2026-09-11`: `bin/setup` 6,802ms, `bin/check` 5,389ms; the `--no-example` shape 5,135ms and 3,909ms ([`wiki/Bare-VM.md`](../../wiki/Bare-VM.md)) |
| `x verify` alone, on an app nobody has built | red on `budgets` — `X_BUDGET_UNMEASURED`, because `.x/build-stats.json` is written by `x build --target static` and by nothing else. The build is `bin/check`'s first line, which is the whole reason the two commands are in that order |
| `lint` on run one | green, zero diagnostics across every source file the scaffold writes, `As of 2026-09-11`. It used to be **name-dependent** — the templates emit `@<app>/…` before `@ultimat3/…`, which `organizeImports` accepted only while the app name sorted first — until `sortedImports` closed that half ([`wiki/Known-Gaps.md`](../../wiki/Known-Gaps.md)) |

Re-derive: `bun run scripts/scaffold-gate.ts <app dir> --json`, which runs that app's own two
scripts and prints the wall time of each.

**No waiver and no fix-follow**, `As of 2026-09`. CI runs exactly those two scripts, once, on every
push, outside the checkout, in `ci.yml`'s `scaffold-smoke` job — and the FIRST `bin/check` is the
one that has to be green, because one pass is all a box gets. The `--allow-red budgets` allowance is
gone: the build ahead of the gate left it nothing to excuse, and `budgets` is now asserted **green**
rather than merely not-red, since a skipped step would mean that build bought nothing
([`scripts/scaffold-gate.ts`](../../scripts/scaffold-gate.ts)). The bounded red-paste-green loop
that used to stand in for this is deleted: "green after running the printed `fix:`" is a weaker
question than the contract asks.

## Irreplaceable at the large end

Nothing here is bought late. Each row is something the beginner's app already has and a large app
cannot retrofit cheaply.

| What the small app already did | What it is worth at size | Anchor |
|---|---|---|
| declared one `policy` per operation | a fifth surface is one adapter, not a second authz system — the failure mode that killed this shape of framework before | [`02-primitives.md`](./02-primitives.md) |
| declared an `action`, not a controller | HTTP, OpenAPI, typed client, job handle, MCP tool and tests stay in step by construction, and `contract-diff` fails the gate when they do not | [`packages/action/README.md`](../../packages/action/README.md) |
| accepted the tier table | an import that would couple two subsystems is a build error, so a codebase with many authors cannot silently grow a cycle | `bun run boundaries`, [`scripts/lib/tiers.ts`](../../scripts/lib/tiers.ts) |
| took `x verify` as the definition of done | one command, 20 steps, the same list in every app — no tribal checklist to hand a new team | [`packages/cli/src/verify-step.ts:16`](../../packages/cli/src/verify-step.ts) |
| used the framework's errors | 552 `X_*` codes, each with a cause and an executable `fix:`, in the terminal, in `problem+json`, in the overlay and under `--json` | `bun run manifest` → `framework.manifest.json` |
| ran `ROLE=web` on one box | the same image is every role; climbing is `ROLE`, env and replica counts | [`17-scale-ladder.md`](./17-scale-ladder.md) |
| never wrote a driver | every seam takes yours — `ServeOptions.runtime` hands the boot a queue, storage, mail, transport, purge, rate-limit store or ISR store ([`packages/cli/src/runtime-overrides.ts:26`](../../packages/cli/src/runtime-overrides.ts)) | [`20-large-app-readiness.md`](./20-large-app-readiness.md) |

Capacity is quoted with its scope and never rounded up: realtime is measured **on one node**, in two
runs that answer different questions (reachability at 50,000 clients, delivery at 10,000), committed
under [`scripts/bench/results/`](../../scripts/bench/results/) and re-checked by
[`scripts/bench-claims.ts`](../../scripts/bench-claims.ts) so a page cannot drift from the run.

## Why this matters more with a cheap model

Everybody is writing code through a model now, on whatever budget they have. The framework's job is
the same either way — **remove decisions and answer mistakes with a command** — and the cheaper the
model, the larger that job's payoff, because a cheap model's failures are exactly the ones a
convention removes.

| What a model would otherwise have to decide | What decides it here | What happens when it guesses anyway |
|---|---|---|
| which library, which pattern, which layout | one blessed path, [axiom 1](./00-thesis.md#design-axioms) | there is no second path to guess between |
| whether a failure is recoverable, and how | a stable `X_*` code, a cause and an executable `fix:`, [axiom 4](./00-thesis.md#design-axioms) | the model runs the `fix:` — every gate finding names a command, and `bun run scripts/doc-fixes.ts` holds the whole error reference to it |
| whether the work is finished | `x verify`, [axiom 5](./00-thesis.md#design-axioms) | green or a named step, never an opinion |
| what the app currently contains | `x.manifest.json` and `--json` on every command | it reads generated facts instead of inferring from source |
| whether an edit crossed a boundary | `boundaries`, `filesize`, `errors`, `i18n`, `seo` as gate steps | a build error at the moment of the edit, not a review comment a week later |
| whether a convention still holds | [axiom 3](./00-thesis.md#design-axioms) — a convention that is not a build error does not exist | prose it never read cannot be violated, because prose is not the rule |

The expensive-model case is the same argument with a different lever: the scarce resource is
context, and an app whose infrastructure is already decided spends its context on the product
([`README.md`](../../README.md#how-much-code-you-do-not-write) measures how much code that is).

## What the range does not claim

| Not claimed | State `As of 2026-08-23` |
|---|---|
| that anyone has shipped a very large app on it | no adoption numbers, no production deployments, no testimonials — [`README.md`](../../README.md) says so and will until they exist |
| that a tracked app is green | `examples/dummy` is pinned red on 4 of 20 steps, `dummy/social-media-clone` on 2 ([`scripts/lib/gated-apps.ts`](../../scripts/lib/gated-apps.ts)) |
| that the top of the ladder is proven | milestone 11 is open: the demo app on Compose **and** Kubernetes from one image, rolling restart invisible, has not been run ([`14-roadmap.md`](./14-roadmap.md)) |
| that offline-first is here | realtime tier 3 (local-first) has not shipped ([`03-realtime.md`](./03-realtime.md)) |
| that the small end is free of holes | a fresh scaffold boots with `X_CONFIG_INVALID` warning that 7 policy-protected routes have no authenticator — the app supplies `configureAuthenticator()` ([`wiki/Known-Gaps.md`](../../wiki/Known-Gaps.md)) |
