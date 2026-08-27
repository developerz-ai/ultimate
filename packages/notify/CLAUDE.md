# @ultimat3/notify — boundary

Tier 4. May import tiers 0-3. Never sideways, never upward.

**Its real imports are `core`, `schema` (tier 0), `time` (tier 1) and `jobs` (tier 3), so tier 4 is
its floor** — one above the highest tier it reaches. It sits AT that floor, so it has no
`FLOOR_ABOVE` row and needs none. The import that fixes it there is `@ultimat3/jobs`: `notifier()`
returns a `job`, which is the whole design.

## What it may never import, and why

| Never | Because |
|---|---|
| `@ultimat3/mail` | Same tier (4). A `Mailer` is declared **structurally** in `channel-mail.ts` — one method, no dependency — exactly as `@ultimat3/action`'s `PgExecutor` mirrors `@ultimat3/db`. Moving `notify` to tier 5 to legalise the import would put notifications above `render`, `pwa` and `ui` for one channel's transport, and would then need a `cli → notify` edge the way `cli → scraping` does. |
| `@ultimat3/render`, `@ultimat3/ui`, `@ultimat3/ai`, `@ultimat3/mcp`, `@ultimat3/pwa` | Same tier. A notification has no view — the inbox is rendered by the app's page out of `InboxStore.list`, which is data. |
| `@ultimat3/db`, `@ultimat3/entity` | Legal downward, and deliberately not taken. The two tables this package owns are **DDL constants applied by the boot** (`SQL_NOTIFY_DELIVERIES_TABLE`, `SQL_NOTIFY_INBOX_TABLE`), the way `x_jobs`, `x_idempotency` and `x_audit` are — never `entity()` declarations, which would put framework tables in the app's migration graph and make an app's `x db gen` responsible for them. The Postgres stores take a structural `PgExecutor`, imported as a **type** from `@ultimat3/jobs` rather than re-declared, because a third copy of a one-method interface is a third place to look. |
| `@ultimat3/policy` | A notification is addressed to exactly one person and the audience is `recipients`. There is no row a policy could decide about here. The **inbox read surface** is where authz belongs, and that is the app's query. |

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

1. `step.run('deliver:<channel>:<recipient>')` — an ordinary retry replays a completed send from the
   step store and does not call the channel.
2. `DeliveryLedger.claim` — an atomic claim keyed `(notifier, key, channel, coalesce(recipient, ''))`,
   taken before the send and settled after it. A claim that already reads `sent` answers `false`, so
   an attempt that lost its step history entirely still does not send twice. **The `coalesce` is
   load-bearing, not decoration**: a bulk channel claims one row for the whole audience with a NULL
   recipient, and NULLs are DISTINCT in a plain unique index — so without it a bulk claim is
   claimable without bound and every replay re-sends the whole audience. `ledger-pg.ts` spells it in
   the index and again in `SQL_NOTIFY_CLAIM`'s `on conflict`, and `errors.test.ts` pins all three
   spellings against each other.

`attempt.ts` is the only place a send happens, so there is exactly one implementation of that order.
The **one at-most-once seam** is a digest flush: `DigestStore.drain` empties the window, and a
process killed between the drain and its checkpoint loses that batch. It is stated in `digest.ts`
rather than hidden, and a durable store can close it.

## Files

| Module | Owns |
|---|---|
| `notifier.ts` | the declaration, and the `job()` it builds |
| `plan.ts` | the declaration types, and the resolved plan every duration is normalised into |
| `fanout.ts` | the run body: audience, wait order, gates, delivery |
| `fanout-digest.ts` · `fanout-walk.ts` | the digest branch, and the state both halves share |
| `attempt.ts` | claim → send → settle, once |
| `channel.ts` · `channel-in-app.ts` · `channel-mail.ts` | the seam and the two shipped channels |
| `ledger.ts` · `ledger-pg.ts` | the delivery ledger, memory and Postgres |
| `inbox.ts` · `inbox-pg.ts` | the in-app inbox, memory and Postgres |
| `preferences.ts` · `digest.ts` | the gate and the window, as seams |
| `stores.ts` | the one installer for all four |
| `retention.ts` | the two sweeps, read off the installed seam |
| `errors.ts` | this package's `X_NOTIFY_*` codes and their titles |

One entry point, deliberately: every module runs on the server, so there is no browser half to split
off.

| Rule | Detail |
|---|---|
| Exports | `src/index.ts`, explicit, no `export *` |
| Errors | `src/errors.ts`, subclass `UltimateError`, never a bare `Error` |
| Files | one responsibility each, < 200 lines, tests beside the source |
| Durations | one vocabulary — `@ultimat3/time`'s. `toDurationMs` is a **narrowing** of `toMs`, never a copy of it: `toMs` screens finiteness and stops, because a negative or fractional duration is real there (`toSeconds(-3000)` is a tested `-3`); a `wait` and a digest `window` are counts of whole FORWARD milliseconds, and the refusal names which declaration was wrong since one notifier holds several. `plan-bounds.test.ts` calls BOTH on the same inputs — the two disagreed once (#372), when only this side was screened, and only a test that calls both can see it come back |

## Retention

Both tables are swept by the boot's hourly `x.purge` job, and neither store is handed to it:
`setNotifyStores` is an APP's boot line that runs when the app's modules import, after the boot that
installs the sweep. So `retention.ts` reads the seam **per attempt** — the same shape as
`purgeAuthLimits()` — and answers `0` for a memory store or none at all, which is a boot that made a
decision rather than a failure.

| Table | Window | Named where |
|---|---|---|
| `x_notify_deliveries` | `PgDeliveryLedgerOptions.windowMs`, default 24 h | beside the statement that reads it. **Never shorter than the app's idempotency window** — a job replayed inside that window against a purged claim claims cleanly and sends twice. Pass `idempotency.windowMs` |
| `x_notify_inbox` | `notify.inboxReadRetentionMs` / `notify.inboxUnreadRetentionMs` in `AppConfig`, **both absent by default** | the app's `app.config.ts`, because an inbox row is a message a person has not read yet and when it disappears is a product decision (axiom 8) |

`purgeBefore` and `purgeExpired` live on the **Postgres stores' own wider types**
(`PgInboxStore`, `PgDeliveryLedger`), never on `InboxStore`/`DeliveryLedger`: adding a method to the
seam every implementation must satisfy is a breaking change for an app that wrote its own, and a
heap map bounded by process life has nothing to delete. Exactly the shape `PostgresIdempotencyStore`
already has.

`packages/cli/src/framework-schema.ts` applies both tables' DDL on every boot, **whether or not that
boot calls `setNotifyStores`** — this file said it did not until 2026-08-27, which is a sentence that
outlived its fact.

Commands: `bun test packages/notify/src`, `bun run boundaries`,
`bunx biome check packages/notify`.
