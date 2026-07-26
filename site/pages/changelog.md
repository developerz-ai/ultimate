---
title: Changelog
nav: Changelog
description: Every Ultimate release, newest first, with the milestone it belongs to — plus an RSS feed generated from this page at build time.
lede: Newest first. Subscribe via [RSS](/feed.xml). Versions are milestone markers, not stability promises — nothing is published to npm yet.
updated: 2026-07-26
---

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
| Pre-v1 | no semver promise. Breaking changes land with a codemod in `x upgrade` and a changelog entry |
| Milestone | each release names the milestone it advances; see the [roadmap](/roadmap/) |
| Feed | this page is the source of `feed.xml` — the RSS is generated at build time, never hand-maintained |
| Detection | a breaking action or query contract fails `x verify` as `X_CONTRACT_DRIFT` before it can ship |

Upgrade instructions, the skew window and the recovery path live in
[Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading).
