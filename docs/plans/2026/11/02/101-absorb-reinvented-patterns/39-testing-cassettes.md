# 39 — Cassettes over `mockFetch`, with the written bytes checked

> Part of [`overview.md`](overview.md). Depends on: [`08-testing-mock-fetch.md`](08-testing-mock-fetch.md). Tier: 5 (`testing`).

## Why
Three adopters hold replayed vendor answers; one has about 140 hand-scrubbed fixtures. Hand-scrubbing is how a live key reaches a repository. 08 gives ordered, method-aware replay, but someone still writes those answers by hand, and a vendor's changed shape stays invisible until production.
Recorded objection: recording plus a redactor is four codes. Answer: replay adds no new mechanism since it registers 08's routes; recording is opt-in by env var; and the one property worth owning, no secret in the written bytes, is a refusal instead of a hope.

## Decisions
| Question | Answer |
|---|---|
| Second mock API? | no. Replay reads a file and calls `mockFetch('<METHOD> <url>', [answers…])` per route. Matching is 08's; a miss is `X_TEST_NETWORK_SEALED` |
| Unsealing | only while recording, only to hosts named in `record: { hosts }`, through `state.allowed` (`sealed-network.ts`). "Never unseal" holds for every ordinary run |
| In CI | recording refused when `CI` is set, so a gate can never reach a vendor |
| Headers | allow-listed on write: `content-type`, `retry-after`, `ratelimit-*`. Request headers never written. A deny-list misses the vendor's next header |
| Request body | never written. A test asserts it through 08's `requestLog` |
| Redaction | keys `isRedactedKey` answers yes to, in JSON at any depth and in query strings; then the app's `redact(text)`. A mechanism plus the app's rule (axiom 8) |
| Secret check | last, over the exact bytes about to be written, including what `redact` returned: every env value whose key `isRedactedKey` matches or `defineEnv({ secret: true })` declared, plus `secrets: []`. Raw, `encodeURIComponent`, base64, base64url. Values under 8 characters skipped, stated. A hit writes nothing and names the KEY and byte offset, never the value |
| Write | temp name then `rename`; sorted keys; non-text bodies base64 |
| Stale | a replay entry unused at dispose fails the test: a recording the code no longer drives is a lie |
| Streams | recorded whole, replayed as one body. An SSE parser's chunk-boundary test stays hand-written |

## Files to change
- `packages/testing/src/cassette.ts` (new) — `cassette()`, replay, dispose check.
- `packages/testing/src/cassette-record.ts` (new) — the recording tap; `cassette-secret-scan.ts` (new) — the scan.
- `packages/testing/src/cassette-errors.ts` (new), `sealed-network.ts:103` — a tap point used only by recording; no new match path.
- `packages/testing/src/index.ts`, `README.md`, `CLAUDE.md`, `wiki/Testing.md:92`, `wiki/Error-Codes.md`. No `examples/dummy` use: its delivery test dials an unresolvable host on purpose.

## Steps
1. Tier 5 codes via `bun run new-error-code <CODE> --package testing --title '…' --cause '…' --fix '…'` (no status flag).
2. `using tape = cassette(import.meta.dir, 'refund-flow', { record?: { hosts }, redact?, secrets? })`. File: `<dir>/__cassettes__/refund-flow.json`.
3. Default mode replays. `ULTIMATE_CASSETTE=record` records when `record.hosts` is given and `CI` is unset.
4. Record: add hosts to `state.allowed`, tap each answer via `clone()`. At dispose: redact, serialise, scan, write. A body failure writes nothing: a half run is not a recording.
5. Replay: group entries by method and URL in order, register, count uses. At dispose unused entries raise.
6. URL query values for redacted keys are masked in the file and on match, so a masked URL matches its real request.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_CASSETTE_MISSING` | replay with no file | `ULTIMATE_CASSETTE=record bun test <file>` with `record: { hosts }` |
| `X_CASSETTE_UNUSED` | entries left at dispose | re-record, or delete the entries `meta.unused` names |
| `X_CASSETTE_SECRET` | a secret's value in the bytes to write; nothing written | extend `redact` to cover env key `<KEY>` at byte `<offset>`, then re-record |
| `X_CASSETTE_RECORD_REFUSED` | recording under `CI`, or a request to a host outside `record.hosts` | record locally; add the host |

## Tests
- `packages/testing/src/cassette.test.ts` (unit): record over an injected transport, then replay with the network sealed, same answers in order; a retry test 503-then-200 survives the round trip; unused raises; missing raises.
- `packages/testing/src/cassette-secret-scan.test.ts` (unit): a value in a body, a URL, base64 and percent-encoded each refused, file absent afterwards, error text holds the key and not the value; `redact` that re-introduces a value still refused. Must be able to fail: remove the scan call and all four go red.
- `packages/testing/src/cassette-ci.test.ts`: `CI` set refuses before any dial. `bun test packages/testing/src/cassette.test.ts`

## Semver
Minor. New export.

## Done when
- A cassette recorded in a test replays with `X_TEST_NETWORK_SEALED` for anything else.
- No value of a redacted env key can reach disk through this path: the scan test proves each encoding.
- `bun run verify` green.

## Risks
- A secret reshaped beyond the four encodings (hashed, split) passes. Allow-listed headers and redacted keys are the first line; the scan is the backstop.
