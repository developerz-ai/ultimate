# Mail

Transactional email as **data**. One template renders an HTML part and a plain-text part, every
string is an i18n key, every colour is a design token, and delivery is a [job](Jobs-And-Workflows).
Package: `@ultimat3/mail` (tier 4) — the full reference is
[`packages/mail/README.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/mail/README.md).

```ts
import { blocks, defineMail, send, t } from '@ultimat3/mail';

export const receiptMail = defineMail({
  id: 'receipt',
  subject: 'mail.receipt.subject',            // an i18n key, never a literal
  input: t.object({ name: t.string, url: t.url }),
  template: ({ data }) => [
    blocks.heading('mail.receipt.heading', { name: data.name }),
    blocks.paragraph('mail.receipt.body'),
    blocks.button('mail.receipt.cta', data.url),
  ],
});

await send(receiptMail, { name: user.name, url }, { to: user.email, locale: ctx.locale });
```

`send` validates the data through the mail's schema, renders, and enqueues `mail.send` through the
jobs facade, so inside a transaction the job commits or rolls back with it. It delivers inline only
with `{ sync: true }` or when no job driver is configured.

## Rules

| Rule | Why |
|---|---|
| `locale` is required by the type | a mail is read hours later; there is no ambient request locale. `X_MAIL_LOCALE_MISSING` backs it for JS callers |
| a text part is mandatory, derived from the blocks | HTML-only mail scores as spam and cannot be read by a screen reader; deriving it from blocks means the two parts cannot drift (`X_MAIL_TEXT_MISSING`) |
| every string is a `mail.<id>.<slot>` key | English ships in the package catalog; an app catalog overrides it — translating the framework mails is shipping keys, never editing a template |
| every date takes an IANA zone | `options.tz`, else `ctx.tz`, else `UTC` |
| no CR/LF in a header-bound field | refused in rendering and again in the send job (`X_MAIL_HEADER_INVALID`), so every driver refuses the same message |
| one recipient rule, inline and queued | `to`, `cc`, `bcc`, `replyTo` take the display form; a control character or a non-ASCII mailbox is `X_MAIL_ADDRESS_INVALID` at `send()`, whichever driver is installed |
| `unsubscribeUrl` is one-click, and one-click is the supported path | it emits `List-Unsubscribe: <url>` plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), and the footer links the same url. Serve it as ONE page: `GET` confirms and never unsubscribes (scanners prefetch), `POST` unsubscribes — `defineRoute({ render: 'ssr', …, post: 'unsubscribe' })` binds the POST to an action with the url's query merged into its input (→ [Routes](Routes-And-Render-Modes)). `unsubscribeOneClick: false` is the fallback for a url that cannot take a POST: the `-Post` line goes |
| sending is a job | `retry: { attempts: 5, backoff: 'exponential' }`, and an idempotency key derived from the mail id and the rendered message, so a retry is one email |

## Which driver a boot installs

`selectMailDriver(env)` is the one answer; `x dev` and every role call it. The app does not change
between environments — the credential does.

| env | driver |
|---|---|
| nothing set, `development` / `test` | `memoryMailDriver()` — caught in the `/_x` mail panel, never sent |
| nothing set, `staging` / `production` | `unconfiguredMailDriver(...)` — every send is `X_MAIL_CREDENTIAL_MISSING`; the boot still succeeds, so an app that sends no mail deploys |
| `SMTP_URL` + `MAIL_FROM` | `smtpMailDriver(...)` — ESMTP over `Bun.connect`, STARTTLS required unless `allowInsecure` |
| `RESEND_API_KEY` + `MAIL_FROM` | `resendMailDriver(...)` — one `POST /emails` with an `Idempotency-Key` |
| `SES_REGION` + `SES_ACCESS_KEY_ID` + `SES_SECRET_ACCESS_KEY` + `MAIL_FROM` | `sesMailDriver(...)` — one SES v2 `SendEmail` with the raw MIME, SigV4-signed, no SDK. `SES_SESSION_TOKEN`, `SES_ENDPOINT`, `SES_CONFIGURATION_SET` optional |

Every key, with what it means: [Configuration → `mail`](Configuration#mail). More than one of
`SMTP_URL`, `RESEND_API_KEY` and `SES_REGION` is `X_CONFIG_INVALID` rather than a silent winner.
`setMailDriver(driver)` is the one seam for a host that builds its own.

## Keeping the sent bytes: `mail.retainMime`

**Off by default; SMTP and SES only.** `As of 2026-10`. The transports that build the MIME can keep
the exact bytes they handed the provider, on `SendResult.mime`.

```ts
// app.config.ts
mail: { retainMime: { maxBytes: 262_144 } },
```

| Rule | Detail |
|---|---|
| `true` | mail's default cap, `DEFAULT_RETAIN_MIME_MAX_BYTES` (256 KiB) |
| over the cap | `{ kind: 'digest-only', sha256, byteLength }` — never a truncated message |
| `maxBytes` | a whole number above 0 (`X_CONFIG_INVALID` at `defineConfig`), at most `RETAIN_MIME_CEILING_BYTES` (10 MiB; `X_CONFIG_INVALID` at boot, judged before a transport is chosen) |
| `RESEND_API_KEY` selected | any retention refuses the boot: Resend builds the MIME on its own side |
| durable copy | `onRetained` is code, not config — a queued send's result is not persisted. Build the driver with `selectMailDriver(env, { retainMime: { onRetained } })` and hand its `.driver` to the `mail` runtime override ([Configuration](Configuration)) |

A throwing `onRetained` is logged (`mail.retain_mime.failed`) and does not fail the send.

## Delivery events: `@ultimat3/mail/events`

**A subpath, never the barrel**: only a webhook route needs it, and every serving role loads
`@ultimat3/mail` to send. One receiver per provider; each verifies the request, then normalises it to
`DeliveryEvent` — `delivered` · `bounced` (`bounce: 'hard' | 'soft'`) · `complained` · `delayed`,
with `messageId` (the sending driver's `SendResult.id`), `recipient`, `at`, `eventId` and `raw`. One
event per recipient; `(eventId, recipient)` is the dedupe key.

```ts
import { resendEventReceiver, sesEventReceiver } from '@ultimat3/mail/events';

export const ses = sesEventReceiver({ topicArns: [Bun.env['SES_EVENTS_TOPIC_ARN'] ?? ''] });
export const resend = resendEventReceiver({ secret: Bun.env['RESEND_WEBHOOK_SECRET'] ?? '' });
// const outcome = await ses.receive(request);  // { type: 'events' | 'ignored' | 'subscription', … }
```

| Receiver | Verifies |
|---|---|
| `sesEventReceiver` | SNS: the topic is in `topicArns`, the certificate URL is `https://sns.<topic region>.amazonaws.com/…pem`, `SignatureVersion` 1 or 2, `Timestamp` within `toleranceMs` (1 h). A `SubscriptionConfirmation` returns its `confirmUrl`; it is fetched only with `confirmSubscriptions: true` |
| `resendEventReceiver` | Svix: HMAC-SHA256 under the `whsec_` secret, constant-time, within `toleranceMs` (5 min) |

Mount `receive(request)` as a plain HTTP route in the `routes` runtime override
([Configuration](Configuration)) — **not** in an `api/**/route.ts`, which cannot register today:
whether that file kind is wired or deleted is an open owner decision ([Known gaps](Known-Gaps#awaiting-an-owner-decision)).
`SES_CONFIGURATION_SET` names the SES configuration set sent on every message (`ConfigurationSetName`) — the set whose event destination publishes to that SNS topic.

## Framework mails

`welcome`, `verify-email`, `reset-password`, `invite`, `mfa-enrolled`, `security-alert` —
registered by importing them (`FRAMEWORK_MAILS`). `registeredMails()` lists them with an app's
own; `renderMessage()` renders one without sending.

## Errors

Every `X_MAIL_*` code is in [Error codes](Error-Codes). The two an app meets first:
`X_MAIL_LOCALE_MISSING` (pass `locale: ctx.locale`) and `X_MAIL_CREDENTIAL_MISSING` (set `SMTP_URL`,
`RESEND_API_KEY`, or `SES_REGION` with its key pair — and `MAIL_FROM` — in the deployment).

Related: [Notify](Notify) fans one event out to mail, the in-app inbox and your own channels;
[Configuration](Configuration) lists the env vars.
