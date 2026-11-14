# 90 — Owner decisions: asked once, each with the default taken if unanswered

> Part of [`overview.md`](overview.md). Nothing here blocks sweep 0. Batch into one message before sweep 1.

## Decisions
| # | Decision | Blocks | Recommendation | Default if unanswered |
|---|---|---|---|---|
| OD0 | Sweep size. House rule: ≤ 4 agents, ≤ 100 files per PR. The last two plans ran at 8–12 agents and 200–400 files under a ruling for that plan only | pacing (10 PRs + audit rounds at the house rule) | 8 agents / ~200 files, with the replacement review (two area-split `bug-hunter` passes, `concurrency-auditor`, `security-auditor`) | house rule |
| OD1 | Authority for outward acts: releases per sweep, demo rollouts, read-only production evidence, PRs in the infrastructure, platform and adopter repositories | sweeps 0, R | authorise for this plan, as for the last two | ask before the first of each kind |
| OD2 | The strict gate ([`07`](07-gate-truth.md) G1): opt-in in 31.x, default on `next` | adopter CI going red | as written | as written |
| OD3 | Majors with no person: `release-due` proposes the `next` merge + bump when the window opens; who merges it | [`11`](11-compat-and-longevity.md) L1 | the maintainer merges after 7 green days of `compat` and the canary on `next`; otherwise the framework is not self-maintained past 31 | proposed only, a person merges |
| OD4 | Security fixes with no person: the platform escalates every `security` item ([`31`](31-maintainer-platform.md) P7) | the "no human" claim | let the maintainer act on dependency advisories and on reports with a reproducer; a person only for a disclosed vulnerability with no fix | stays escalated; recorded as the one human dependency |
| OD5 | A per-agent access handle to the read-only production scripts ([`30`](30-infra.md) I10) | the weekly `evidence` brief | grant, read-only, audited | the brief runs on the gateway and tracker only; logs and pods stay manual |
| OD6 | A PIN / device-operator sign-in method in `auth` (one adopter) | [`04`](04-auth-http.md) step 4 | no: a recipe over the authenticator | recipe |
| OD7 | Media generation in the AI gateway, sandboxed jobs, PDF assembly and signing (one adopter each) | scope of [`06`](06-ai-mail-scraping-ui.md) | no: app code over primitives, each a tested recipe | recipes |
| OD8 | Desktop, mobile, OTA and `x branch` leave the roadmap for `wiki/Known-Gaps.md` as "not planned" ([`13`](13-shapes-and-declaration.md) step 3) | the definition of finished | yes: finished means no intended work is left unbuilt | yes |
| OD9 | Adopter D ([`43`](43-adopter-d.md)): scaffold a real app or drop the pin | slice 43 | drop the pin until the web platform is started | drop |
| OD10 | The previous-major lane ([`11`](11-compat-and-longevity.md) L2): build `release/30.x` + `maint-30`, or shorten the promise in `SECURITY.md` to "current major only" | L2 | build it: outside users on 30 were promised six months | build |

## Outward-facing steps the executor asks for once
| # | Step | When |
|---|---|---|
| S1 | Releases: a patch after sweep 0, a minor per merged sweep and per audit fix sweep | after each merge |
| S2 | Rolling the demo and reading production evidence through the infrastructure repository's read-only paths | after each release |
| S3 | PRs in the infrastructure repository ([`30`](30-infra.md)) and issues or PRs in the maintainer platform's ([`31`](31-maintainer-platform.md)) | from sweep 0 |
| S4 | Adopter PRs, one or more per repository ([`40`](40-adopter-a.md)–[`49`](49-adopter-j.md)) | sweep R |
| S5 | Creating `next` and `release/30.x` on the remote; publishing under `maint-30` | sweep 8 |

## Done when
- Every row has an answer or its default recorded here with a date.
