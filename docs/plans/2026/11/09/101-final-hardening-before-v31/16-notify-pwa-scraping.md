# 16 — notify, pwa, scraping: big audiences, asset-resolved manifests, a pinned browser

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 4 (`notify`, `pwa`, `scraping`). Mail spans are [`20`](20-observability.md); SMS is [`23`](23-feature-gaps.md).

## Findings
| # | Sev | Site | Failure | Fix |
|---|---|---|---|---|
| N1 | Med (scale) | `notify/src/fanout.ts:171-186`, `:138-162` | one preference read per recipient per channel, one durable step per recipient, serially: 10k audience = 20k+ round trips and 10k `x_job_steps` rows | `PreferenceStore.allowsMany(ids, channel)` (optional in 30.x, required in v31); steps per chunk of 500 recipients with stable names |
| N2 | Low (tests) | `notify/src/fcm.ts` (211), `apns.ts` (145) | covered only indirectly | golden-payload tests per transport (data-only, alert, collapse id, TTL) |
| N3 | Low–Med (adopter-found) | `pwa/src/manifest.ts:143` | `screenshots` passed verbatim, never through `asset()`; an adopter recomputes content hashes by hand | resolve `screenshots[].src` (and icons if they share the path) through the asset table |
| N4 | **Med (security, SSRF)** | `scraping/src/cdp-arm.ts:223-238`, `core/src/host-rules.ts:63-80` | the browser path checks `allowHosts` by hostname only; HTTP and robots paths resolve and pin (`pinned-host.ts:1-6`). Under a wildcard, a name resolving to `169.254.169.254` or `10.x` loads in a browser inside the worker network; output returns in the snapshot/PDF. Helm egress is open by default ([`25`](25-helm-docker.md)) | for hosts admitted only by a wildcard, `screenDial` before `Fetch.continueRequest`; fail the request when the address is not public. Record `refused: 'host'` in the ring |

## Files to change
- `packages/notify/src/fanout.ts`, `preference-store.ts` (interface), postgres + memory preference stores, `fcm.test.ts`/`apns.test.ts` (new goldens).
- `packages/pwa/src/manifest.ts`.
- `packages/scraping/src/cdp-arm.ts`.
- `packages/notify/README.md`, `packages/scraping/README.md`.

## Tests
- `fanout.test.ts`: 10k audience → preference reads ≤ 2 × ⌈10k/500⌉ per channel; step names stable across a replay.
- `manifest.test.ts`: screenshot `src` resolves to the hashed asset path.
- `cdp-arm.test.ts`: resolver maps a wildcard-admitted name to `10.0.0.1` → `Fetch.failRequest`, ring entry `refused: 'host'`.
- `bun test packages/notify packages/pwa packages/scraping`

## Done when
- The SSRF probe is refused; a 10k-recipient fan-out completes in bounded round trips.
