# 04 — Framework gaps, tier 3: signed live cursor, unknown-key warning, `decide(rows)`, device wire version, job status

> Part of [`overview.md`](overview.md). Depends on: 03 (`unknownKeys`, `evaluateEach`). Tier: 3 (`action`, `query`, `realtime`, `jobs`). Closes the `main` halves of #1280 and #1281; their breaks go to [`10-next-breaks.md`](10-next-breaks.md).

## Files to change

| Item | Files | Change |
|---|---|---|
| #1280 signed cursor | `packages/realtime/src/cursor-sign.ts` (new, server-only) | `keyedFingerprint({ qid, lsn, ids: sha256(sorted ids), sub: actor id + tenant }, 'realtime-live-cursor')`; `at` excluded (client clock); ids digest cached by array identity (`advance` returns the same `ids` ref on update-only patches) |
| | `packages/realtime/src/cursor.ts:22`, `sync-protocol.ts:389` | `LiveCursor.sig?`, `PatchFrame.sig?`; decoder reads a bounded string, drops a malformed one. Optional field ⇒ no `PROTOCOL_VERSION` bump; add a fixture in `sync-protocol.test.ts`. |
| | `live-fanout.ts:166`, `live-resume.ts:72,79`, snapshot path | sign at snapshot, after `advance`, after the seat; verify with `compareFingerprint` before `new Set(cursor.ids)` |
| | `client-frames.ts:79,95` | store the frame's `sig` beside its cursor, echo it; patch without `sig` clears it. Client never recomputes. |
| | main behaviour | valid `sig` ⇒ trusted ids; **present but mismatched `sig` ⇒ cold start** (only our server mints `sig`, so no legitimate client sends a bad one — not a break); absent `sig` ⇒ today's behaviour + a counted hook (legacy clients). Cold start for unsigned cursors is the `next` break. Do **not** intersect ids with policy (breaks revoked-while-away `withdrawn`, per the issue). |
| #1281 warning | `packages/action/src/**` input parse, `packages/query/src/validate.ts` | after a successful input parse, `unknownKeys()`; non-empty ⇒ structured warn `X_INPUT_UNKNOWN_KEY` (log-only, `bun run new-error-code … --package action`) with `nearestName` (`packages/core/src/nearest-name.ts`); listed in meta for the dev timeline. Precedent: `X_ENTITY_ALL_TRUNCATED` (`packages/entity/src/all-truncated.ts`). Never walks output or rows. |
| `decide(rows)` | `packages/action/src/**` (`ActionHandlerArgs`) | `decide(rows) → { allowed, denied: [{ row, code, reason }] }` running the action's own policy via `evaluateEach` on the action's surface through `guardPrimitive`; absent before the input stage; handler cannot name another policy. `PRIMITIVE_FACTORIES` untouched. |
| Device wire version | `packages/realtime/src/device-wire.ts:23-28` | `DEVICE_WIRE_VERSION = 1`; node always sends `v` in hello; `decodeNodeFrame` reads absent `v` as 1; `device-agent.ts:112` closes with `X_DEVICE_WIRE_VERSION` when `v` > spoken (realtime pair-2 flag — check `bun run new-error-code --help`) |
| | `packages/realtime/src/device-wire-frames.ts` (new typed table, not `*-fixture.ts` — those aren't published), `packages/realtime/wire/device-v1.json` (generated, `--check` like `scripts/guards-doc.ts`), `package.json` `files` + export | published fixtures `{ name, direction, text, valid }` incl. rejected frames, for non-JS clients; run the package-shape step |
| Job status / cancel | `packages/jobs/src/inspect.ts`, `index.ts` | `jobStatusFor(driver, { jobId, tenantId, name? })`, `cancelJobFor(…)`; public `JobStatus` = state, progress, attempt, timestamps — never `input`, `stack`, `lastError`, `traceparent`. Tenant mismatch answers `undefined` (indistinguishable from missing). Not a factory: `jobs`/`action`/`query` are all tier 3 (no sideways), and who may cancel is policy. |
| | `examples/dummy/**` | one `query` + one `action` over it under the app's own policy — the idiomatic recipe |

## Steps

1. Workers: B1 `packages/action/src/**`, `packages/query/src/**`; B2 `packages/realtime/src/device-*.ts`, `realtime/wire/**`, `realtime/package.json`, the fixture script; B3 `packages/realtime/src/{cursor*,live-*,sync-protocol,subscriber-gate,client-frames,server}.ts`; B4 `packages/jobs/src/{inspect*,job-status*,index}.ts`, `examples/dummy/**`. B2/B3 share `realtime/src/index.ts`: B3 owns it, B2 sends its export line to B3.
2. Coordinator: error codes, manifest, changelog, **`scripts/lib/next-breaks-list.ts` rows** for #1280 (unsigned ⇒ cold start), #1281 (refuse unknown keys), device hello without `v` refused, plus `wiki/Known-Gaps.md` lines matching `PARKED_ON_NEXT` ("flips on `next`"). Then 01 action 4 (regenerate #1162 body).
3. Check the `Subscriber` type exposes actor id + tenant for the cursor binding; check every `.job()` enqueue stamps `tenantId`.

## Tests

- `packages/realtime/src/cursor-sign.test.ts`; `live-resume-signed.test.ts` — on `main`: a forged id under a mismatched `sig` cold-starts and gets no `delete`; an unsigned cursor takes the legacy path and bumps the counter; a genuinely held, revoked row still gets `withdrawn`; the `next` test (slice 10) requires cold start for unsigned too; client round trip; signing never enters the page graph (`cursor.ts` imports `@ultimat3/core/page`).
- `packages/action/src/http.test.ts`, `packages/query/src/http.test.ts` — `limt` warns with nearest `limit`, answer still 200 and unchanged; MCP `cross-surface.test.ts` unchanged.
- `action-decide.test.ts` — mixed rows; another policy unnameable.
- `device-wire-conformance.test.ts` — every fixture through both decoders, round trip.
- `packages/jobs/src/job-status.test.ts` — cross-tenant ≡ missing; null-tenant job unreachable from a tenant call; reference app contract test.

## Done when

- Forged cursor ids leak nothing when a `sig` is present (mismatch ⇒ cold start); unsigned leaks as today until `next`; #1280 comment links the `next` row; #1281 likewise.
- Device fixtures published in the npm tarball (`bun run scripts/package-shape.ts` or the `package-shape` step).
- `bun run verify` green; app gate green.
