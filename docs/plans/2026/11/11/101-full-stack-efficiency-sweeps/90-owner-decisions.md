# 90 — Owner decisions: asked once, each with the default the executor takes if unanswered

> Part of [`overview.md`](overview.md). Nothing here blocks sweeps 0, 19a, 1, 2 or 5a. Batch these into one message to the owner before sweep 5b.

## Decisions

| # | Decision | Blocks | Recommendation | Default if unanswered |
|---|---|---|---|---|
| OD0 | Sweep size. House rule: ≤ 4 agents, ≤ 100 files per PR. Earlier plans ran wider under a ruling for that plan only | pacing of the whole plan (18 PRs in this repository at the house rule) | keep the house rule for the defect and tier 0–3 sweeps; widen to 8 agents / ~200 files for the mechanical sweeps (17a, 17b, 18) with the replacement review (two area-split `bug-hunter` passes, `concurrency-auditor`, `security-auditor`) | the house rule everywhere |
| OD1 | Event-loop-lag load shedding on by default ([`06`](06-http.md) H10) | H10's default value | ship default **off** in 31.x with the drill; turn on at the next major | off |
| OD2 | Job priority inside a queue ([`09`](09-jobs.md) J15) | J15 | no column: document "priority = a separate queue". A priority key widens the claim index on the hottest table | document, close the row |
| OD3 | The four stub commands with no parts in the tree: `x status`, `x branch`, `x ai`, `x money` ([`14`](14-cli-commands-upgrade.md) U5) | U5's second half | ship `x status` (needs a build-id aggregate in `realtime`); remove `branch`, `ai`, `money` from the registry until designed | remove all four from the registry; `x status` stays a roadmap row |
| OD4 | A duplex byte-stream channel kind in `realtime` (one adopter serves a terminal by long-poll) ([`10`](10-realtime.md) R5) | R5, adopter B step 4 | out of scope for the framework: one app, and a business-shaped transport | document as out of scope |
| OD5 | `rollup()` derive-on-write (a per-row summary maintained in the writer's transaction; one adopter keeps a 365-line tally) | adopter G step 7 | defer: one app; `countedIn` + [`05`](05-entity.md) E10 covers the common case | defer |
| OD6 | A declared optimistic-lock column on entities and mutators, `X_ENTITY_STALE` 409 ([`05`](05-entity.md) E14) | E14 | ship: lost updates are a defect in every business, and today the only tool is a hand-written filter | not built; row stays open in `wiki/Known-Gaps.md` |
| OD7 | The island template renders inside an error boundary whose fallback is the server's HTML ([`11`](11-render-islands.md) I5). Changes the template every scaffold copies; existing apps adopt by a guard's fix | I5 | ship | ship the helper and the guard report-only; the template change waits |
| OD8 | Media generation (image, audio) in the AI gateway ([`12`](12-notify-ai-mcp-pwa.md) AI3) | AI3 | defer until a second app asks | defer |
| OD9 | Adopter F: revive and upgrade 19 → 31, or record as dormant ([`45`](45-adopter-f.md)) | slice 45 | dormant | dormant |
| OD10 | Breaking items parked for `next` (the next major is no earlier than 2027-02-08, `X_RELEASE_MAJOR_WINDOW`): `.all()` refusing when a cursor remains ([`05`](05-entity.md) E12); dropping redundant indexes by default (E9); removing `updateWhere`/`deleteWhere` (E1) and `sitemap`'s `now` ([`04`](04-cache-seo.md) K4); verify steps floored by default ([`13`](13-cli-exercise-verify.md) X8) | nothing on `main` | open a `next` tracking issue listing the five; each ships its non-breaking half now | as recommended |

## Outward-facing steps the executor asks for once
| # | Step | When |
|---|---|---|
| S1 | Releases: one patch after sweep 0, then a minor per merged framework sweep or pair of sweeps (`chore/release-X.Y.Z` branch; merging the bump PR is the release) | after each sweep's merge |
| S2 | Upstream ask to Bun: `COPY FROM STDIN` in the SQL client, and a per-query `prepare` switch ([`03`](03-db.md) D3, D7) — only if the probes find them absent | sweep 1 |
| S3 | Rolling the demo after each release, and reading production evidence through the infrastructure repo's read-only paths ([`30`](30-infra.md)) | after each release |
| S4 | Adopter PRs, one per repository, each from its own checkout or worktree ([`40`](40-adopter-a.md)–[`49`](49-adopter-j.md)) | sweep R |

## Done when
- Every row has an answer or its default recorded here with a date.
- A `next` tracking issue exists for OD10.

## Answers (2026-11-11, owner delegated every decision to the executor: "take all decisions")
| # | Answer |
|---|---|
| OD0 | widened, as the run authority for this plan: up to 8 agents and ~200 files per sweep; mechanical sweeps (17a, 17b, 18) may merge pairs; review agents as recommended |
| OD1 | off in 31.x, with the drill |
| OD2 | document "priority = a separate queue"; row closed |
| OD3 | as recommended: ship `x status`; remove `branch`, `ai`, `money` from the registry |
| OD4 | out of scope; documented |
| OD5 | deferred |
| OD6 | ship E14 |
| OD7 | ship I5 including the template change |
| OD8 | deferred |
| OD9 | dormant |
| OD10 | as recommended: a `next` tracking issue; non-breaking halves ship now |
| S1–S4 | authorised |
