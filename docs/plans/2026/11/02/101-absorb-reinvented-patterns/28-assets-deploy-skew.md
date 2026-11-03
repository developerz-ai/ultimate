# 28 — Hashed assets survive a deploy

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0 (`core`), 5 (`cli`). **Decided: build it, both the doc fix and the retention half (`assets.retain`). No adopter has hand-rolled retention; it rests on the zero-downtime goal. `docs/idea/12-build-deploy.md` promises a window that does not exist.** [`33-ops-deploy-proof.md`](33-ops-deploy-proof.md) step 6 depends on the retention half.

## Why
`docs/idea/12-build-deploy.md:170` promises "the previous build's assets are still served under the N-deploy retention window", and `:133` repeats it. No such window exists. Each process serves only what it built:

| Route | Miss | Source |
|---|---|---|
| `/styles/*` | 404 | `packages/cli/src/style-routes.ts:33`; `minted` is per process, `style-bundle.ts:100` |
| `/islands/*` | 404 | `packages/cli/src/island-routes.ts:33-49` |
| `/assets/*` | 404 on a hash that no longer matches | `packages/cli/src/site-asset-routes.ts:79` |

Failure, from source read, not a live rollout: an open tab holds a document from the last build. Its `interaction` island imports its chunk on the first click, the new pod answers 404, the island is `data-x-failed` and the button is dead until a reload. Every deploy, one replica or many. During a rolling update the two directions add up: a new document reaching an old pod gets no stylesheet. An ISR page in a CDN names the old hash until it is purged.

`page-navigation.ts:39` covers soft navigation only. Bytes retained per deploy in the reference app: 712,353 of text plus site assets.

Zero adopters hand-rolled this; none of the three could from outside these routes.

## Files to change
- `packages/core/src/config-assets.ts` (new) — `assets: { retain?: { disk: string; builds: number } }`, screened with `finiteCount`, one row in `config-shape`. Absent means today's behaviour. `builds` has no default: a retention window is the app's.
- `packages/cli/src/retained-assets.ts` (new) — `publishBuildAssets`, `readRetainedAsset`.
- `packages/cli/src/serve-web.ts` — publish before the role reports ready.
- `packages/cli/src/style-routes.ts:33`, `island-routes.ts:33`, `site-asset-routes.ts:79`, and the routes under `FRAMEWORK_ASSET_BASE_PATH` (`worker-bundle.ts:22`) — ask `readRetainedAsset` on a miss, before the 404.
- `docs/idea/12-build-deploy.md:17,21,38,133,170` — correct: `:17` and `:21` deny hashed assets and `:38` denies a client bundle, all shipped since; `:133` and `:170` state the option and what happens without it.
- `wiki/Deployment.md`, `wiki/Static-Assets.md` — the option and the static-export rule: a host keeps old hashed files because nothing deletes them.
- `wiki/Known-Gaps.md` — a row while `retain` is unset: an open tab can hit a dead island across a deploy.

## Steps
1. Key: `x-build-assets/<url path>`. Content-addressed, so two builds with one file share one object. Outside `org/`, so `assertReadableKey` refuses it on `/_storage` and `/media`.
2. `publishBuildAssets({ disk, buildId, urls })` at web-role boot, before readiness: skip when `x-build-assets/builds/<buildId>.json` exists, put each file not already present, write that manifest last. New pods publish before an old pod can receive their document, because a pod takes no traffic until `/readyz`.
3. A file over the disk's `maxPutBytes` (default 10 MB, one adopter ships 30 MB of site assets) is skipped and listed in one `assets.retain_skipped` line. Never buffered past the disk's own ceiling.
4. Sweep at the end of a publish: list the manifests, keep the newest `builds`, delete objects no kept manifest names. A pod killed mid-sweep leaves extra objects, never a missing one, since manifests are read first.
5. `readRetainedAsset(pathname)`: only a path already matching that route's hashed shape, so a miss costs at most one disk read and no scan. Hit: `200` with the route's content type and `immutable`. Miss: today's `no-store` 404.
6. Publish failure logs the code and the pod still serves. A stale tab is a smaller harm than a failed deploy.
7. `x dev` never publishes: `serve-web.ts` is the container's.
8. The boot reads the section the `*Of(config)` way, as `runtime-jobs.ts` does.

A disk the web role can read is the whole requirement: an S3-compatible bucket, or a shared volume on one box. No CDN, no platform primitive: axiom 7.

## Error codes
`bun run new-error-code X_ASSET_RETAIN_FAILED --package cli --title 'Build assets were not retained' --cause 'publishing this build to the retained-asset disk failed' --fix 'x doctor --json' --off-socket`
| Code | When | Fix |
|---|---|---|
| `X_ASSET_RETAIN_FAILED` | a put, list or delete refused during publish; logged, boot continues | `x doctor --json` |
| `X_CONFIG_INVALID` (existing) | `retain.disk` names no declared disk, or `builds` is not a positive integer | name a disk from `defineStorage` |

## Tests
- `packages/cli/src/retained-assets.test.ts`, unit, memory disk: publish twice is idempotent; `builds: 2` after three publishes deletes only the file unique to the oldest; a shared file stays; the manifest is written last, proved by a disk that refuses its put.
- `packages/cli/src/style-routes.test.ts`, `island-routes.test.ts`, `site-assets.test.ts`: a miss present on the disk answers 200 `immutable`; absent, the 404 with `no-store`; a path outside the hashed shape never touches the disk (counting driver).
- `packages/core/src/config-assets.test.ts`: `builds: 0` and `NaN` refused.
- One `.e2e` in `packages/cli/e2e/`: two process boots with different app bytes over one local disk; each serves the other's stylesheet. Fails on `main`.
- `bun test packages/cli/src/retained-assets.test.ts`

## Semver
Minor; off unless declared. The doc corrections change no behaviour.

## Done when
- With `retain` set, either pod of a two-pod rollout answers both builds' `/styles` and `/islands` URLs.
- `docs/idea/12-build-deploy.md` states nothing the code does not do.
- `examples/dummy/app.config.ts` does not declare it: not a primitive. `wiki/Deployment.md` carries the example.
