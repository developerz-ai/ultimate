# @ultimat3/notify — boundary

Tier 4. May import tiers 0-3. Never sideways, never upward.

**Its real imports are `core`, `schema` (tier 0), `time`, `i18n` (tier 1), `policy` (tier 2),
`action` and `jobs` (tier 3), so tier 4 is its floor** — one above the highest tier it reaches. It
sits AT that floor, so it has no `FLOOR_ABOVE` row and needs none. The import that fixes it there is `@ultimat3/jobs`: `notifier()`
returns a `job`, which is the whole design.

## What it may never import, and why

| Never | Because |
|---|---|
| `@ultimat3/mail` | Same tier (4). A `Mailer` is declared **structurally** in `channel-mail.ts` — one method, no dependency — exactly as `PgExecutor` (`@ultimat3/core`) mirrors `@ultimat3/db`. Moving `notify` to tier 5 to legalise the import would put notifications above `render`, `pwa` and `ui` for one channel's transport, and would then need a `cli → notify` edge the way `cli → scraping` does. |
| `@ultimat3/render`, `@ultimat3/ui`, `@ultimat3/ai`, `@ultimat3/mcp`, `@ultimat3/pwa` | Same tier. A notification has no view — the inbox is rendered by the app's page out of `InboxStore.list`, which is data. `pushChannel` takes a STRUCTURAL `Pusher` (`channel-push.ts`), exactly as `mailChannel` takes a `Mailer`: `@ultimat3/pwa`'s `webPush()` satisfies it, and `NotifyPushMessage` mirrors pwa's `PushNotification` field for field — catalog keys, never text. |
| `@ultimat3/db`, `@ultimat3/entity` | Legal downward, and deliberately not taken. The three tables this package owns are **DDL constants applied by the boot** (`SQL_NOTIFY_DELIVERIES_TABLE`, `SQL_NOTIFY_INBOX_TABLE`, `SQL_NOTIFY_DIGESTS_TABLE`), the way `x_jobs`, `x_idempotency` and `x_audit` are — never `entity()` declarations, which would put framework tables in the app's migration graph and make an app's `x db gen` responsible for them. The Postgres stores take a structural `PgExecutor`, imported as a **type** from `@ultimat3/core` (its one declaration; `bun run flight-copies` refuses another, `X_HELPER_COPY`). |
| `@ultimat3/pwa` for native push | `nativePush()` (APNs + FCM) lives HERE, not in `pwa`: a native app is no progressive web app, and the pusher is `pushChannel`'s seam. It shares no code with `webPush()` — different wire, different auth, different store (`x_push_devices`, not `x_push_subscriptions`). |

`@ultimat3/policy` and `@ultimat3/action` are taken for ONE file, `push-register.ts`: device
registration is an action with a policy (`can()`, an agent denied), exactly as pwa's
`pushSubscribe`. A notification itself still has no row a policy decides about — the audience is
`recipients`, and the inbox read surface is the app's query. `pushRegister` / `pushUnregister` are
factories over `action` and need rows in `PRIMITIVE_FACTORIES`.

## What ships, and what must never

`docs/idea/20-large-app-readiness.md` scores this row **Ship, as a job factory** — *"channel fan-out,
preference gate, digest window, delivery ledger, in-app inbox"* — and is equally explicit about the
other half: **the notification taxonomy and `quietHours` must never ship.**

So `PreferenceStore` is an interface with two trivial implementations and nothing else. This package
ships the **gate**; the app ships what the gate reads — which notification types exist, what a
"marketing" one is, and what hours are quiet in which recipient's zone. `DigestWindow.window` is a
**rolling duration** and never a calendar time, for the same reason plus one more: no date is
computed here without an explicit IANA zone, so a window this package could get wrong is a window it
does not offer. "Every day at 09:00 local" is a `task()` and the app's schedule.

## `notifier()` is a job, not a ninth primitive

A notification is durable background work with an input schema, an idempotency key, a retry policy
and a queue — the definition of a `job`. `notifier()` therefore *returns* one, and inherits
`.enqueue()`, `.as()`, the worker's cancellation, the dead-letter path, `x jobs show` and its
manifest row. Its row is in `PRIMITIVE_FACTORIES` (`packages/core/src/registrar.ts`);
`scripts/primitive-factories.test.ts` fails if the export and the row disagree.

## At-least-once, in two layers

A job body runs **before** its checkpoint lands, so both layers are load-bearing:

1. `step.run('deliver:<channel>:chunk-<n>')` — one step per `NOTIFY_CHUNK_SIZE` (500) recipients,
   `n` the chunk's place in the audience `open` froze (never in the ALLOWED list, which a retry
   re-reads). A retry replays a completed chunk from the step store; a chunk that failed part-way
   re-runs whole, and layer 2 answers `sent` for whoever it already reached. Preferences are read
   once per chunk (`PreferenceStore.allowsMany`, required since 31.0.0): 10k recipients is 20 reads
   and 20 step rows a channel, not 20k (`fanout-chunks.test.ts`). Inside a chunk,
   `NOTIFY_DELIVERY_WIDTH` (16) recipients are in flight; a failed one is thrown only after its
   neighbours were tried (first retryable failure wins). A digest reads preferences per
   chunk and sends per chunk (`digest-send:<channel>:chunk-<n>`, ledger-fenced the same way), but
   its `digest:` append and `digest-drain:` steps stay ONE PER RECIPIENT: a chunked append re-runs
   appends whose joined window may be drained by then (below), and a chunked drain widens the
   drain seam's loss from one batch to 500.
2. `DeliveryLedger.claim` — an atomic claim keyed `(notifier, key, channel, coalesce(recipient, ''))`,
   taken before the send and settled after it. A claim that already reads `sent` answers `false`, so
   an attempt that lost its step history entirely still does not send twice. **The `coalesce` is
   load-bearing, not decoration**: a bulk channel claims one row for the whole audience with a NULL
   recipient, and NULLs are DISTINCT in a plain unique index — so without it a bulk claim is
   claimable without bound and every replay re-sends the whole audience. `ledger-pg.ts` spells it in
   the index and again in `SQL_NOTIFY_CLAIM`'s `on conflict`, and `errors.test.ts` pins all three
   spellings against each other.

`attempt.ts` is the only place a send happens, so there is exactly one implementation of that order.

**A claim has one owner, and `held` is not `sent`** (`As of 2026-11-02`). `claim` answers
`owned` (with a `claimId`), `sent` or `held`. A `sending` row fires only past `reclaimAfterMs`
(`DEFAULT_DELIVERY_RECLAIM_MS`, 5 min, on the job's clock); `settle` is fenced `claim_id = $7 and
status = 'sending'` as `SQL_IDEMPOTENCY_SETTLE` is, and `false` is logged `notify.settle_fenced`.
`attemptDelivery` raises `held` as `X_NOTIFY_DELIVERY_HELD` (`retry-after`, the window's remainder
in `meta.retryAfterSeconds`, deferred by jobs' `rateLimitDeferralMs` with the attempt uncounted) and
never returns `false` for it: `false` checkpoints the step, and a
holder that then dies is a notification no retry is left to send (`attempt.test.ts`,
`deliveryLedgerConformance` in `@ultimat3/testing/conformance` (`notify-stores-conformance-postgres.live.test.ts`)).

The **one at-most-once seam** is a digest flush: `DigestStore.drain` empties the window, and a
process killed between the drain and its checkpoint loses that batch. It is stated in `digest.ts`
rather than hidden. `postgresDigestStore` makes the window itself durable and shared — the
partial unique index `x_notify_digests_open_idx` lets two replicas' first appends collide so ONE
opens the window and owns the flush; an elapsed open window is sealed and the append retried — but
its `drain` is still a delete, so the seam is unchanged (`digestStoreConformance` in `@ultimat3/testing/conformance` (`notify-stores-conformance-postgres.live.test.ts`)
runs one suite against both stores).

**A digest append is ONE STEP PER RECIPIENT, and idempotent per appender** (`As of 2026-10-05`).
The append pass was one `step.run`, and a step that fails part-way re-runs WHOLE: recipients already
appended read `opened: false` from the window they had opened and it was never drained, and a window
they had JOINED could have been drained and deleted by its owner meanwhile, so their event went out
in a second digest. Now `digest:<channel>:<recipient>` is a step each (the step store is the
durable fence; one row per recipient, as `deliver:` already writes), and behind it
`DigestAppend.appender` (`${runId}:${recipient}`) is stored per window — `appended_by text[]`,
opener first — so an append whose answer was lost, or a run whose step history is gone, gets back
the window it landed in while that window exists. Two executions of one appender at once (a lapsed
lease) cannot both join: the `do update` refuses an appender already in the row. Pinned by
`fanout-digest.test.ts` and `@ultimat3/testing/conformance` (`notify-stores-conformance-postgres.live.test.ts`).

**The audience is deduplicated by `id` once, as it leaves the `open` step** (`As of 2026-10-02`).
Every per-recipient step is named by the id, so a resolver that named one person twice failed
`X_STEP_DUPLICATE` part-way through the fan-out, on every retry. Outside the step rather than in it,
so an `open` checkpointed with duplicates by an earlier version is repaired on replay too.

## Files

| Module | Owns |
|---|---|
| `notifier.ts` | the declaration, and the `job()` it builds |
| `plan.ts` | the declaration types, and the resolved plan every duration is normalised into |
| `fanout.ts` | the run body: audience, wait order, gates, delivery |
| `fanout-digest.ts` · `fanout-walk.ts` | the digest branch, and the state both halves share |
| `attempt.ts` | claim → send → settle, once |
| `channel.ts` · `channel-in-app.ts` · `channel-mail.ts` · `channel-push.ts` | the seam and the three shipped channels; `pushChannel({ data })` is the data-only form, typed to a `DataPusher` so `webPush()` cannot take it |
| `ledger.ts` · `ledger-pg.ts` | the delivery ledger, memory and Postgres |
| `inbox.ts` · `inbox-pg.ts` | the in-app inbox, memory and Postgres |
| `preferences.ts` · `digest.ts` | the gate and the window, as seams |
| `digest-pg.ts` | the digest window in Postgres: one row per window, at most one OPEN per slot |
| `stores.ts` | the one installer for all four (`installNotifyStores`) and the reads behind it |
| `adapter.ts` | `@ultimat3/notify/adapter`: the installer + reset, the four store interfaces, `NotifyStoreMissingError` — never the `.` barrel; an app's line is `notifyStores:` in `apps/<app>/runtime.ts` |
| `retention.ts` | the three sweeps, read off the installed seam |
| `errors.ts` | this package's `X_NOTIFY_*` codes and their titles |
| `native-push.ts` | `nativePush()`: every device of a person, dead tokens dropped, bad tokens counted, a credential refusal ending its provider's fan-out, refusals coded |
| `apns.ts` · `fcm.ts` | one device's send per provider: credential, wire shape, answer |
| `native-jwt.ts` · `token-cache.ts` · `native-transport.ts` | ES256/RS256 over WebCrypto; one credential per lifetime; the env key read and the refusal read back |
| `push-message.ts` | a visible push rendered, a data-only push screened to ids |
| `push-device.ts` · `push-device-pg.ts` | the device seam, memory and Postgres (`x_push_devices`) |
| `push-register.ts` | `pushRegister` / `pushUnregister`, factories over `action` |
| `push-errors.ts` | `X_NOTIFY_PUSH_*`, registered in `errors.ts` |
| `sms-transport.ts` · `sms-channel.ts` · `sms-errors.ts` | the `smsTransport` port (an `ADAPTER_PORTS` row: interface + installer on `./adapter`, memory reference, E.164 check), the reference `smsChannel()`, and `X_NOTIFY_SMS_*`. A provider is the app's adapter, never shipped (axiom 8) |

One entry point, deliberately: every module runs on the server, so there is no browser half to split
off.

**The two inbox stores answer one question one way, and the two places they did not were both in
`list`/`markRead`** (`As of 2026-09`). `markRead`'s contract is that an id belonging to nobody is
*simply absent* — the memory store skips it — while the Postgres one bound the caller's ids into
`any($2::uuid[])`, so one malformed id raised 22P02 out of the store and the nineteen good ids in
the batch went unmarked. `postgresInboxStore` screens with `isUuid` before binding and answers `0`
with no round trip when nothing survives; the statement keeps its `::uuid[]` cast and its primary
key index, which `id::text = any($2)` would have given up. And the memory `list` now sorts
`(createdAt desc, notifier, key)` — the total order `SQL_NOTIFY_INBOX_PAGE` takes — because
`createdAt` alone is partial and a bounded page over two notifications written in one millisecond
can drop one and repeat the other.

**The tail is `(notifier, key)` and never `id`, `As of 2026-09-06`.** Both stores had a tail and
they were two different total orders: `postgresInboxStore` mints a UUIDv7 that Postgres compares by
its 16 BYTES, while `memoryInboxStore` derives its id from
`JSON.stringify([recipient, notifier, key])` and compares by code point — so equal-`createdAt` rows
came back one way in dev and the other in production, which is the drop-and-repeat the tail exists
to prevent, on whichever driver nobody tested against. `(notifier, key)` is unique within a
recipient by the table's own `unique (recipient, notifier, key)`, which is also what makes `add`
idempotent. The statement spells `collate "C"` on both columns: the memory store compares by code
point and a database initialised under ICU or `en_US.UTF-8` orders text by locale rules, so without
it the two would split on exactly the Unicode keys nobody writes a test for.

| Rule | Detail |
|---|---|
| Exports | `src/index.ts`, explicit, no `export *`: the app API only (v31): every kept export's option/result types and every error class stay; channel-name constants, env names, internal bounds and guards do not |
| Errors | `src/errors.ts`, subclass `UltimateError`, never a bare `Error` |
| Files | one responsibility each, < 200 lines, tests beside the source |
| Durations | one vocabulary — `@ultimat3/time`'s. `toDurationMs` is a **narrowing** of `toMs`, never a copy of it: `toMs` screens finiteness and stops, because a negative or fractional duration is real there (`toSeconds(-3000)` is a tested `-3`); a `wait` and a digest `window` are counts of whole FORWARD milliseconds, and the refusal names which declaration was wrong since one notifier holds several. `plan-bounds.test.ts` calls BOTH on the same inputs — the two disagreed once (#372), when only this side was screened, and only a test that calls both can see it come back |

## Retention

All three tables are swept by the boot's hourly `x.purge` job, and no store is handed to it:
the stores are an APP's `notifyStores:` line in `apps/<app>/runtime.ts`, installed after the boot that
installs the sweep. So `retention.ts` reads the seam **per attempt** — the same shape as
`purgeAuthLimits()` — and answers `0` for a memory store or none at all, which is a boot that made a
decision rather than a failure.

| Table | Window | Named where |
|---|---|---|
| `x_notify_deliveries` | `PostgresDeliveryLedgerOptions.windowMs`, default 24 h | beside the statement that reads it. **Never shorter than the app's idempotency window** — a job replayed inside that window against a purged claim claims cleanly and sends twice. Pass `idempotency.windowMs` |
| `x_notify_digests` | `PostgresDigestStoreOptions.retentionMs`, default 7 days after the window closed | beside the statement that reads it, like the ledger's |
| `x_notify_inbox` | `notify.inboxReadRetentionMs` / `notify.inboxUnreadRetentionMs` in `AppConfig`, **both absent by default** | the app's `app.config.ts`, because an inbox row is a message a person has not read yet and when it disappears is a product decision (axiom 8) |

`purgeBefore` and `purgeExpired` live on the **Postgres stores' own wider types**
(`PostgresInboxStore`, `PostgresDeliveryLedger`, `PostgresDigestStore`), never on the seams: adding a method to
the seam every implementation must satisfy is a breaking change for an app that wrote its own, and a
heap map bounded by process life has nothing to delete. Exactly the shape `PostgresIdempotencyStore`
already has.

`x_notify_digests`: every window is deleted by its own flush's `drain`, or by the next window's
drain of the same slot (`ends_at <=`). The one neither reaches — a flush that dead-lettered, on a
slot that never digests again — is the sweep's (`purgeNotifyDigests` → `PostgresDigestStore.purgeExpired`,
`As of 2026-10-02`): windows CLOSED more than `retentionMs` before the job's clock, default
`DEFAULT_DIGEST_RETENTION_MS` (7 days, longer than any flush's retries), deleted in batches of
`DIGEST_PURGE_BATCH` and at most `DIGEST_PURGE_MAX_BATCHES` statements per pass.

`packages/cli/src/framework-schema.ts` applies every notify table's DDL on every boot, **whether or not that
boot installs notify stores** — this file said it did not until 2026-08-27, which is a sentence that
outlived its fact.

Commands: `bun test ./packages/notify/`, `bun run boundaries`,
`bunx biome check packages/notify`.
