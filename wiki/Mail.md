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

`send` validates the data through the mail's schema, renders, and enqueues `mail.send`. It delivers
inline only with `{ sync: true }` or when no job driver is configured.

## Rules

| Rule | Why |
|---|---|
| `locale` is required by the type | a mail is read hours later; there is no ambient request locale. `X_MAIL_LOCALE_MISSING` backs it for JS callers |
| a text part is mandatory, derived from the blocks | HTML-only mail scores as spam and cannot be read by a screen reader; deriving it from blocks means the two parts cannot drift (`X_MAIL_TEXT_MISSING`) |
| every string is a `mail.<id>.<slot>` key | English ships in the package catalog; an app catalog overrides it — translating the framework mails is shipping keys, never editing a template |
| every date takes an IANA zone | `options.tz`, else `ctx.tz`, else `UTC` |
| no CR/LF in a header-bound field | refused in rendering and again in the send job (`X_MAIL_HEADER_INVALID`), so every driver refuses the same message |
| `unsubscribeUrl` is one-click unless you say otherwise | it emits `List-Unsubscribe: <url>` plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), a promise that a POST to that URL unsubscribes. When the URL is a confirm page — GET shows a button and must never unsubscribe, because scanners prefetch — pass `unsubscribeOneClick: false`: the `-Post` line goes, `List-Unsubscribe` and the footer link stay |
| sending is a job | `retry: { attempts: 5, backoff: 'exponential' }`, and an idempotency key derived from the mail id and the rendered message, so a retry is one email |

## Which driver a boot installs

`selectMailDriver(env)` is the one answer; `x dev` and every role call it. The app does not change
between environments — the credential does.

| env | driver |
|---|---|
| nothing set, `development` / `test` | `createMemoryDriver()` — caught in the `/_x` mail panel, never sent |
| nothing set, `staging` / `production` | `createUnconfiguredDriver(...)` — every send is `X_MAIL_CREDENTIAL_MISSING`; the boot still succeeds, so an app that sends no mail deploys |
| `SMTP_URL` + `MAIL_FROM` | `createSmtpDriver(...)` — ESMTP over `Bun.connect`, STARTTLS required unless `allowInsecure` |
| `RESEND_API_KEY` + `MAIL_FROM` | `createResendDriver(...)` — one `POST /emails` with an `Idempotency-Key` |

Both credentials at once is `X_CONFIG_INVALID` rather than a silent winner. `setMailDriver(driver)`
is the one seam for a host that builds its own.

## Framework mails

`welcome`, `verify-email`, `reset-password`, `invite`, `mfa-enrolled`, `security-alert` —
registered by importing them (`FRAMEWORK_MAILS`). `registeredMails()` lists them with an app's
own; `renderMessage()` renders one without sending.

## Errors

Every `X_MAIL_*` code is in [Error codes](Error-Codes). The two an app meets first:
`X_MAIL_LOCALE_MISSING` (pass `locale: ctx.locale`) and `X_MAIL_CREDENTIAL_MISSING` (set `SMTP_URL`
or `RESEND_API_KEY`, and `MAIL_FROM`, in the deployment).

Related: [Notify](Notify) fans one event out to mail, the in-app inbox and your own channels;
[Configuration](Configuration) lists the env vars.
