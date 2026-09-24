# Notify

**One declaration, many channels**: fan-out, a preference gate, a digest window, a delivery ledger
and an in-app inbox. Package `@ultimat3/notify` (tier 4) — the full reference is
[`packages/notify/README.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/notify/README.md).

`notifier()` is a **job factory**: it returns a `JobHandle`, so a notification inherits retry, the
dead-letter path, cancellation, `x jobs show` and its manifest row — the same shape `backfill()`
and `llm()` take ([The eight primitives](The-Eight-Primitives)). It is not a ninth primitive.

```ts
import { inAppChannel, mailChannel, notifier, t } from '@ultimat3/notify';

export const commentPosted = notifier({
  name: 'post.commented',
  input: t.object({ postId: t.uuid, orgId: t.uuid, author: t.string }),
  tenant: (params) => params.orgId,          // required, as on job()
  key: (params) => `comment:${params.postId}`, // the queue's dedupe key AND the ledger's event key
  recipients: ({ input, ctx }) => posts.subscribers(input.postId, ctx.signal),
  deliver: [
    { channel: inAppChannel() },               // immediately
    {
      channel: mailChannel({ mailer }),
      wait: '10m',                             // then re-read the condition: a mute in minute 3 wins
      unless: ({ event }) => event.params.author === 'system',
      digest: { window: '1h', group: (event) => event.params.postId },
    },
  ],
});

await commentPosted.enqueue({ params: { postId, orgId, author } });
```

## The stores

`setNotifyStores({ ledger, inbox, digest, preferences })` once at boot, whole-object replacement:

| Store | Default | Postgres |
|---|---|---|
| `ledger` — the delivery claim | in-memory (one process is genuinely deduped) | `createPgDeliveryLedger({ executor, windowMs })` — `windowMs` never shorter than your idempotency window |
| `preferences` — the gate | allow all | yours: **the gate ships, what it reads never does** — your taxonomy, your quiet hours |
| `inbox` | none — `X_NOTIFY_STORE_MISSING` | `createPgInboxStore({ executor })` |
| `digest` | none — `X_NOTIFY_STORE_MISSING` | `createMemoryDigestStore()` |

The hourly `x.purge` job sweeps the Postgres ledger and inbox. The inbox is swept only when your
`app.config.ts` sets `notify.inboxReadRetentionMs` / `notify.inboxUnreadRetentionMs` — when an unread
message disappears is your decision ([Configuration](Configuration)).

## Channels, the inbox, and at-least-once

- `channel(name, fn)` delivers per recipient; `bulkChannel(name, fn)` makes **one** call for the
  whole audience (a Slack post, a webhook) and cannot take a digest (`X_NOTIFY_DIGEST_UNSUPPORTED`).
  `inAppChannel()` and `mailChannel({ mailer })` ship; `mailer` is structural, so [Mail](Mail) plugs
  in without an import.
- `requireInbox(name)` answers `list`, `unreadCount`, `markSeen`, `markRead`. `seenAt` and `readAt`
  are two facts, and the unread count is derived, never stored.
- A replay does not send twice: the step checkpoint per channel and recipient, and the ledger's
  atomic claim on `(notifier, key, channel, recipient)` taken before the send.
- Entries fire in `wait` order; `if` / `unless` run **after** the wait, on the attempt that delivers.

Codes: `X_NOTIFY_CHANNELS_EMPTY`, `X_NOTIFY_CHANNEL_DUPLICATE`, `X_NOTIFY_DIGEST_UNSUPPORTED`,
`X_NOTIFY_FANOUT_TOO_WIDE` (default cap 500 recipients), `X_NOTIFY_STORE_MISSING`,
`X_NOTIFY_DELIVERY_FAILED` — [Error codes](Error-Codes).
