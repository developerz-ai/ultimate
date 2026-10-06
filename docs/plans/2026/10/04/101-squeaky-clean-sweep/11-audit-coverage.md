# 11 — Audit coverage: what was read, what was falsified, what nobody reached

> Part of [`overview.md`](overview.md). Depends on: none (read-only). **Sweep 11 — a read-only audit
> wave (≤ 4 agents), run any time after sweep 2; its findings append rows to the slice owning the
> package, or open a new slice.** Source: 13 read-only agents over two waves at `d7b8c7fa`, 2026-10-04.

## Rule
Do not re-audit what is falsified below; do not call the framework "audited" while the unreached list
is non-empty. Each wave-3 agent gets one band and the "already known" list of every slice it touches.

## Falsified — chased and disproved (do not re-report)

| Area | Disproved lead |
|---|---|
| money | `allocateByRatios` `-0`; negative/tiny divisor sign; `fromDecimal` excess precision |
| cache | LRU row bust vs bare-collection keys; ladder promotion stale near tier; fence ring partial drop; redis tag fence ordering |
| http | rate-limit memory vs pg parity; CSRF/`sec-fetch-site`; HSTS only when HTTPS affirmed; handler CSP appended; `problem-meta` `__proto__`; security-headers `extend` via `Map` |
| entity / policy | memory vs pg predicates (`eq`/`neq`/`in` with null/undefined, `like` null, `has-key`); tenancy `in` refused; `not(and(deny, can))`; bulk-write collision parity; transition CAS; preload ceiling |
| auth | MFA challenge reuse (fresh TOTP + metered); jwks `none`/HS256, kid refresh TTL; id-token order + `azp`; password KDF on empty/unreadable hash; rate-limit memory vs pg; oauth cookie timing-safe + provider bound |
| storage | signed-URL extension via `&x-max=`/`&x-ct=`; path `..`/encoded separators/`.meta`; `accept.ts` constraints; local sidecar/pending collision |
| db | transaction nested turns, abort, commit-unknown; migrate advisory lock on one pinned session; `reserveWithin` late connection |
| core | seal AAD binds purpose; otlp bounds + one batch in flight; logger redaction; lifecycle re-entrant drain |
| jobs | memory vs pg every operator verb (claim/cancel/requeue/promote/remove/pause); step store parity; backfill ledger; outbox relay re-publish fenced; `limits.ts` bounded; scheduler leader window |
| realtime | offline-queue epoch/ack/abandon; channel ring epoch + gap; presence roster; pgoutput DEFAULT `'K'`; pg socket/handshake/advisory lock; `sync-upgrade` capacity recheck; `ws.send` −1 = queued |
| mcp | exposure via one predicate `isMcpExposed`; readonly-sql comment/CR/dollar-tag; `validate-args` own-key + pattern cache; transport auth before body, failure buckets |
| render / pwa / ui | stream reveal-once/cancel; ISR fence + `latest` guard; html `on*`/`srcdoc`/`__proto__`; css-modules scoping; registry collisions; form field-path grammar |
| ai | budget reserve/derive atomicity; gateway stream release; llm-cache scope + locale key |
| notify / mail | inbox/digest/ledger memory vs pg; digest ledger key collision; mail CR/LF/C1 refusal |
| cli / ci / release | `verify merge` fail-closed; 5 CI parts cover 20 steps once; release tag-ref/conclusion/`--check`; deploy-social-demo main + success; ratchet `Object.hasOwn`; `cmd-secrets`; storage upload signature-before-body; `jobs drain` lease handback; `db reset` refuses external DB; helm sync `PORT`; static memo + policy refused (`render/src/modes.ts:101`) |
| admin / scraping | `decideAll` empty list; audit logs parity; destroy token; row action `id` last; row-scope write fail-closed; scraping redirect screening + credential latch; auth burn race |
| hygiene | `boundaries` (floors), `llms-txt`, `claude-md-size`, `declaration-readers`, `dead-docs-host`, `guards-doc --check`, `gate-steps` green; `expectedRed` `{}` in both apps; package deps = imports; no `any`/default export/`export *`/unzoned `Intl` in any package `src` |

## Unreached — wave 3 bands (≤ 4 agents)

| Agent | Band |
|---|---|
| R1 — tiers 0–2 | core `config*`, `otlp-metric-exporter`, `seal-keys`, `image/`; **schema (whole)**; db `generate`, `drift`, `introspect*`, `transaction-options`; entity `seed`, `jit-preload`, `aggregate*`, `sealed*`, `repo`; auth `builtin-adapter`, `kdf-gate`, `mfa-challenge`; time `zoned`, `zones`, `cron-describe`; storage `attachment`, `image`, **memory-vs-local driver parity**; seo `images`, `image-driver`, `meta` |
| R2 — tiers 3–4 | realtime `client`, `sync-node*`, `live-query`, `live-replicator`, `replicator`, `record-store`, `page-outbox`, `socket-engine`; jobs `execute`, `backfill-pass`, `outbox-pg`, `outbox-relay`, `scheduler*`; ai `llm`, `agent`, `openai-provider/messages/body`, `provider`; render `route`; manifest `build`, `docs-*`, `sources*`, `schema`; mcp `server`; **ui `components/` + `form/`**; notify `fanout` beyond digest |
| R3 — cli | `island-shot*`, `island-capture`, `island-verdict`, `island-harness*`, `island-states-load`, `island-link`, `island-realtime`, `island-solid-dedupe`; `app-boundaries`, `app-transport`, `app-permissions*`, `app-evals`, `app-agents-md`, `app-artifacts`, `app-entities`, `app-env`, `app-openapi`, `app-root`, `server-barrels`; `dev-policy`, `image-prepare`, `static-report`, `measure-scope`; `cmd-new`, `cmd-i18n`, `cmd-shot-island`, `verify-stalled`, `verify-coverage-run`, `verify-role-load*`; **~70 generator templates** (`action`, `job`, `query`, `entity`, `resource-*`, `route`) |
| R4 — harness, scripts, ops | testing `cdp-launch*`, `cdp-e2e-*`, `e2e-locator/page/evaluate/selection`, `island-*`, `fixture-*`; scraping `driver-cdp`, `cdp-*`, `session-state`; **~75 top-level guards + 61 `scripts/lib/*`** (each: can it fail? which real form slips?); `docker/docker-compose.dev.yml`, `docker/deploy-proof/load.ts`; admin notify/PWA SW internals; NATS/KV transport auth |

## Doc facts with no guard (found by 10e)

| Fact | Where it is stated | Executable copy | Guard to add |
|---|---|---|---|
| the scaffold runs uid/gid 1000; this repo's chart runs 65532 | `docs/ops/01-kubernetes.md:238`, `docs/ops/README.md:111` | `RUNTIME_UID` (`cli/src/templates/scaffold-helm.ts:18`), `docker/helm/values.yaml:107` | a doc-drift test reading both constants |
| wiki code fences compile | every `wiki/*.md` ```ts fence | — (`readme-fences` covers package READMEs only) | a `wiki-fences` ratchet on `scripts/lib/readme-fences.ts` |
| a wiki `Page#anchor` link resolves | wiki cross-links | the target page's heading slugs | a wiki-anchor check beside `doc-paths` |
| a Known-Gaps row's issue is open, and its B-row is not marked complete | `wiki/Known-Gaps.md` | GitHub issue state, `status.yml` | a check on the issue links (offline: against `status.yml` only) |
| the number of boundary rules and their codes | `docs/architecture/02-boundaries.md:37` | `BOUNDARY_CODES` (`cli/src/app-boundaries.ts:31-38`) | a test that compares the table's rows with the list |

## Steps
1. One read-only wave, four agents (bands above), each told: no edits, no spawning, no git, probes in the scratchpad.
2. Coordinator folds findings into the owning slice's table (new rows, next free number) in a docs-only PR, and updates `status.yml`.

## Done when
- Every band reported; unreached list empty or each remaining file named with a reason.
