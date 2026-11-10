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
| a mail with an unresolved key is not sent | `send()` throws `X_MAIL_KEY_MISSING` before the transform and the queue, and it is terminal: a key the locale lacks, a catalog value still holding `⟦…⟧`, or a `{slot}` with no value (`meta.keys`, `meta.slots`). A framework mail counts, so a locale that has not translated `mail.*` is refused. `renderMessage()` still returns the `⟦…⟧`, because a preview should show it. A `⟦` from your data sends. `x verify` catches the app's own keys earlier: `blocks.*`, `subject:` ([I18n](I18n)). A framework template's keys live in the package, so no source scan reads them |
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
`mail:` in `export const runtime = { … }` (`apps/<app>/runtime.ts`) is the one seam for an app that builds its own — the `mail` adapter port: `MailDriver` from `@ultimat3/mail/adapter`, `memoryMailDriver` to copy, `behavesLike(mailDriverConformance, () => yourDriver())` to prove it ([Adapters](Adapters#mail)). There is no `setMailDriver` (31.0.0); a test swaps one for itself with `await swapAdapter('mail', driver)` from `@ultimat3/testing`.

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

Mount a receiver through `webhookReceiver()` ([Jobs and workflows](Jobs-And-Workflows#inbound-webhooks)),
the one door for an inbound webhook. Its `verify` calls `ses.receive(inbound.request())` — a fresh
`Request` over the exact bytes, verified there — and returns `{ eventId, payload }` with the events
as the payload (the SNS `MessageId` as the id), or `{ answer: Response }` for a subscription
confirm. Its `handle` applies the stored events in the worker without verifying again, so a retry
an hour later is not refused by the signature window. Declaring it is its registration: the boot
mounts its route. `api/` holds no route file.
`SES_CONFIGURATION_SET` names the SES configuration set sent on every message (`ConfigurationSetName`) — the set whose event destination publishes to that SNS topic.

## Previews

`As of 2026-11-06`. `defineMail({ preview })` declares the data a template is checked by: a value,
parsed by `input` where it is written (`X_MAIL_PREVIEW_INVALID`), or `(locale) => data`, parsed at
each render. Never production rows. `x mail preview <id> [--locale <tag>] [--tz <zone>] [--out <dir>] [--json]`
renders it per locale with nothing sent, naming every key a locale lacks; `x verify`'s `i18n` step
renders every declared preview in every locale, so a preview is also a test. `previewMail(id,
{ locale })` is the same render for a host. A mail with none: `X_MAIL_PREVIEW_MISSING`.

The `/_x` mail panel lists every registered mail beside the caught ones (`templates`): each declared
`preview` rendered in each of the app's locales, dates in UTC, with the keys a locale lacks as
`templateGaps` and a preview its schema refuses shown as that refusal. A mail with no `preview` is
listed with `hasPreview: false`. `?template=<id>` selects one; `x dev`'s panel and its `--json`
payload are the same facts.

## No framework mails

Rule: `@ultimat3/mail` registers no mail. `As of 31.0.0`. Every mail an app sends is its own
`defineMail()`, with its `mail.<id>.*` keys in the app's catalog; the base catalog carries
`mail.footer.*` only. `registeredMails()` lists what the app declared; `renderMessage()` renders one
without sending.

| Mail | Where it comes from |
|---|---|
| email verification, password reset | `@ultimat3/auth` sends `auth.email-verify` / `auth.password-reset` through the app's `MailSender`, keys in the app catalog |
| welcome, invite, security alert, anything else | the app's own `defineMail()` — business convention, never shipped (axiom 8) |

The six v30 mails (`welcome`, `verify-email`, `reset-password`, `invite`, `mfa-enrolled`,
`security-alert`, `FRAMEWORK_MAILS`) are deleted: [Upgrading](Upgrading) entry 54.

## Errors

Every `X_MAIL_*` code is in [Error codes](Error-Codes). The two an app meets first:
`X_MAIL_LOCALE_MISSING` (pass `locale: ctx.locale`) and `X_MAIL_CREDENTIAL_MISSING` (set `SMTP_URL`,
`RESEND_API_KEY`, or `SES_REGION` with its key pair — and `MAIL_FROM` — in the deployment).

Related: [Notify](Notify) fans one event out to mail, the in-app inbox and your own channels;
[Configuration](Configuration) lists the env vars.
