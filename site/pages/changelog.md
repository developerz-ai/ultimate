---
title: Changelog
nav: Changelog
description: Every Ultimate release, newest first, with the milestone it belongs to — plus an RSS feed generated from this page at build time.
lede: Newest first. Subscribe via [RSS](/feed.xml). One version for the whole framework — 28 packages, released in lockstep to npm.
updated: 2026-08-10
---

## 1.0.0 — 2026-08-10

First major. 27 `@ultimat3/*` packages plus the unscoped `create-ultimate` — 28 in all — publish
at 1.0.0 in lockstep: one version, one commit, one tag, pushed to npm by OIDC trusted publishing
with no `NPM_TOKEN`. **Semver applies from here.**

- **The eight primitives** — `entity`, `policy`, `action`, `mutator`, `query`, `job`, `route`, `task` — with their shapes frozen under semver. A ninth primitive is not a feature request; a new capability arrives as a factory over an existing one.
- **One authz object across every surface.** A `policy` is evaluated for the HTTP call, the typed client call, the job execution, the MCP tool call and the live-query subscription. No trusted-tool mode, no second permission table.
- **The error contract.** Every failure is an `UltimateError` with a stable `X_*` code, a cause, a runnable `fix:` and `--json`. `x verify` fails a `fix:` that names no command.
- **AI-first surface.** MCP dev server, every exposed action as a tool with identical authz, `x.manifest.json` generated every build, `llm()` as an action factory with budgets and semantic caching, and evals as a gate step — a prompt with no eval fails `x verify`.
- **Postgres entity driver** (`postgresDriver()`) plus PGlite, so `x dev` needs no Docker and no `.env` scavenger hunt.
- **Realtime tiers 1–2**: channels and live queries over a Postgres logical-replication change feed, an incremental matcher, a NATS bus for fanout and a stateless `sync` role.
- **Mail and OAuth**, alongside storage, four-tier caching with one tag graph, PWA and offline, i18n, money, time and SEO.
- **`x verify` is 17 steps**: typecheck, lint, boundaries, filesize, package-shape, errors, unit, contract, live, job, e2e, eval, drift, contract-diff, budgets, manifest, roadmap. No `--only`, no `--skip` — green means shippable or it means nothing.
- **`bunx create-ultimate myapp`** scaffolds an app whose generated code passes `x verify` unmodified, with every `@ultimat3/*` dependency pinned to one exact version.

Not claimed in 1.0.0, and named here rather than buried: no published realtime benchmark — the
50k-socket forced-restart number is still unmeasured, so capacity figures are targets, not
results. Milestone 11's two-platform deploy proof — the demo app on Compose **and** Kubernetes
from one image, with a rolling restart invisible to connected clients — is not yet demonstrated,
though the three build targets, both compose files and the Helm chart all ship. Deferred to v2
behind the same interfaces: tier 3 local-first (`persist: true`), a plugin API, multi-region
replication, and the `redis` / `nats` job drivers, which throw `X_NOT_IMPLEMENTED` with a
runnable `fix:` rather than pretending to work.

## 0.0.1 — 2026-07-26

Repository bootstrap. Milestone 0 in progress; nothing published, no API stable.

- `@ultimat3/core`: `UltimateError` with stable `X_*` code, cause, exact fix command and `--json` form; the framework-wide error-code registry; runtime roles; ids and clock.
- Package tiers wired with `scripts/boundaries.ts` — a tier violation is a build error, not a lint warning.
- Skeletons for `schema`, `i18n`, `money`, `time`, `cache`, `seo`, `entity`, `policy`, `http`, `action`, `query`, `jobs`, `realtime`, `ui`.
- Repo conventions locked: Biome, `verbatimModuleSyntax`, named exports only, tests next to source, no `any`, no raw hex colours, no hardcoded user-facing strings.
- Docs: the thesis, the locked stack, the eight primitives, realtime, jobs, caching, surfaces, rendering + SEO, PWA, AI-first, testing, topology, build + deploy.
- This site — 0kb JS baseline, inlined critical CSS, dark and light from the same tokens — plus the wiki and `llms.txt`.

## How releases work

| Rule | Detail |
|---|---|
| Version | one number for the whole framework. Every `@ultimat3/*` package moves together |
| Semver | from 1.0.0, a breaking change to a documented API needs a major. The `X_*` codes, the eight primitive shapes, the `x` CLI surface and the tier table are all covered |
| Lockstep | all 28 packages publish at one version, from one commit and one tag, to npm via OIDC trusted publishing — no `NPM_TOKEN`. Pin exactly; never mix versions |
| Milestone | each release names the milestone it advances; see the [roadmap](/roadmap/) |
| Feed | this page is the source of `feed.xml` — the RSS is generated at build time, never hand-maintained |
| Detection | a breaking action or query contract fails `x verify` as `X_CONTRACT_DRIFT` before it can ship |

Upgrade instructions, the skew window and the recovery path live in
[Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading).
