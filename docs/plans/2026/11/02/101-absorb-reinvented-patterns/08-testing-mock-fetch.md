# 08 — `mockFetch` that can answer a retry test

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 5 (`testing`). Lands inside the breaking batch.

## Why
Three or more adopters replay vendor answers. One holds about 140 JSON fixtures plus ~90 hand-written helpers around one 16-line `scriptedFetch`; none uses `mockFetch`.
Why, reproduced against `testing/src/sealed-network.ts`:
- Method-blind: one registration answered both `GET` and `POST` (`latest:GET | latest:POST`).
- Not ordered: two calls, one answer (`200 200`), so a 503-then-200 retry test needs a counter closure. This is the first thing `scriptedFetch` adds.
- No record of the request: `requestedUrls()` is URLs only, so a test cannot assert a bearer header or a body. The second thing `scriptedFetch` adds, as `calls[i].init`.
- A mock of a name misses a pinned dial: `https://<address>/a` with `host: vendor.test` threw `X_TEST_NETWORK_SEALED`.

## Decisions
| Question | Answer |
|---|---|
| Second API beside `mockFetch`? | no. It grows the missing facts |
| `requestedUrls()` | deleted. `requestLog()` holds the same record and more, and two readers of one record are two ways (axiom 1) |
| Record-and-replay files | deferred, [`90-deferred.md`](90-deferred.md) |
| `seamContract()` | killed. One adopter, and the helper is `for (const make of [real, fake]) describe(…)` |

## Files to change
- `packages/testing/src/sealed-network.ts:43` (`matches`), `:103` (the patched fetch), `:168` (`mockFetch`), `:188` (`requestedUrls`, deleted), `:212` (`captureNetwork`), `socketRefusal` — method prefix, ordered answers, the request log, host-aware matching.
- `packages/testing/src/index.ts:335` — `requestLog` replaces `requestedUrls`.
- `packages/testing/src/harness.test.ts:213`, `sealed-network.test.ts:85,128` — move to `requestLog`.
- `packages/testing/README.md:372`, `packages/testing/CLAUDE.md`, `wiki/Testing.md:92,796`, `wiki/Upgrading.md`. No `examples/dummy` use: a test helper, not a primitive, and its delivery test deliberately dials an unresolvable host.

## Steps
1. `mockFetch(match, answer)`: a string `match` also takes `'POST https://…'`, the spelling `x shot` states already use (`wiki/Testing.md:309`), parsed into a new optional `MockRoute.method`. A bare URL and a RegExp keep today's meaning, every verb. `mockJson` inherits it.
2. `answer` also takes an array of `Response | Error`, answered in order, the last repeated, each `clone()`d so a repeat has a body; an `Error` is thrown. An empty array is refused through core's `assert` (`X_INVARIANT`), naming the match.
3. `requestLog()` returns `{ method, url, headers, body }[]`, in order, unredacted, process-local. Replaces `state.seen`, so `resetNetwork` clears it and `captureNetwork` carries it. Body read from a clone, so the handler and the real call still get theirs. A socket dial logs through `socketRefusal` with empty `headers` and `body: null`: the record keeps the three dials.
4. When a request's URL host is an address literal and it carries a `host` header, a route is matched against that header's name as well as the URL.

## Error codes
None new. `X_INVARIANT` for an empty answer list; `X_TEST_NETWORK_SEALED` for an unmatched call, as today, and its fix text gains no new spelling.

## Tests
- `packages/testing/src/sealed-network.test.ts`, extended: method prefix misses the other verb; array answers in order, then repeats with a readable body; `Error` thrown; `requestLog` holds the header and the body and a handler can still read that body; socket dial logged; literal host + `host` header matches; a bare URL still answers every verb; empty array refused; nested `captureNetwork` restores the log.
- `bun test packages/testing/src/sealed-network.test.ts`.

## Semver
Breaking: `requestedUrls` is removed. Upgrading entry: "`requestedUrls()` is gone; `requestLog().map((call) => call.url)` answers the same list." A `match` string beginning with a verb and a space could not previously match any URL, so that growth breaks nothing.

## Done when
- A retry test needs no counter and asserts a header, from one registration.
- `grep -rn requestedUrls packages wiki` answers nothing outside the Upgrading entry.
- `bun run verify` green.
