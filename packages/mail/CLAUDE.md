# @ultimat3/mail — agent notes

**Tier 3.** May import `core`, `schema`, `i18n`, `time`, `money`, `jobs`; never `auth`, `http`, `ui`, `render`. **Zero external deps** — no nodemailer, no MJML, no CSS library.

## Boundary

| File | Single responsibility |
|---|---|
| `mail.ts` | `defineMail`, the registry, `send` / `sendById` / `renderMessage` |
| `templates/` | the six framework mails, as data |
| `blocks.ts` | the template vocabulary: `MailBlock`, `blocks`, `MailTemplate`, `TemplateArgs` |
| `render.ts` | blocks → HTML **and** text, plus the layout call and the footer slots |
| `layout.ts` | `MAIL_TOKENS` (light + dark), the 600px table shell, layout registry |
| `driver.ts` | `MailDriver` + memory/log + `resultFor` + the `setMailDriver` seam |
| `driver-smtp.ts` | `createSmtpDriver`: `SMTP_URL` parsing, the pool ceiling, one send |
| `driver-resend.ts` | `createResendDriver`: one `POST /emails`, status → retryable |
| `smtp-client.ts` | the conversation: greeting → EHLO → STARTTLS → AUTH → envelope → DATA |
| `smtp-protocol.ts` | pure protocol: reply framing, capabilities, AUTH payloads, dot-stuffing |
| `smtp-socket.ts` | the one production `SmtpStream`, over `Bun.connect` |
| `mime.ts` | `MailMessage` → RFC 5322: header order, RFC 2047, folding, quoted-printable |
| `base64.ts` | base64 over UTF-8 bytes, shared by RFC 2047 and SMTP AUTH |
| `job.ts` | `sendMailJob` and the envelope schema |
| `idempotency.ts` | `mailIdempotencyKey` — apart from `job.ts` because the transports need it too |
| `catalog.ts` | English source strings for `mail.*`. Data, not code |
| `html.ts` | escaping + `safeUrl`. The only place that builds an attribute |

## Rules

- `src/index.ts` re-exports `t` from `@ultimat3/schema` **verbatim**, so a `defineMail` file
  imports one package. Never wrap, spread or re-declare it: `t` delegates to `schemaProvider()` on
  every access, and a copy would freeze the provider at import time. `index.test.ts` asserts identity.
- `SendOptions.locale` is non-optional in the type. Never relax it, never default it.
- Text part is derived from blocks and must be non-empty (`X_MAIL_TEXT_MISSING`).
- No literal user-facing string in `templates/` or `layout.ts` — keys only.
- No hex outside `MAIL_TOKENS`. Base styling is inlined (clients strip `<style>`); dark mode is
  one `prefers-color-scheme` block keyed on short `data-x` role codes.
- Never format a date without `options.tz`. The `Date:` header is UTC, stated as `+0000`.
- New block kind: `MailBlock` + `blocks` + `htmlOf` + `textOf`, same commit.
- A transport failure is `sendFailed({ stage, status, retryable, fix })` — never a bare throw, and
  never a `retryable` guess. `stage` is the `SendStage` union in `errors.ts`; a new step goes there
  first. The transient set is 4xx over SMTP, and 408/409/425/429 + 5xx over HTTP — that HTTP set
  lives in `RETRYABLE_STATUSES` (`driver-resend.ts`) and is edited there, never restated.
- `Bcc` is an envelope field. It reaches `RCPT TO` and Resend's body, never a header.
- Recipient addresses stay out of logs and out of error text we write ourselves; the server's own
  reply is passed through verbatim, and that is where the refused address comes from.
- Every header value is checked for CR/LF (`X_MAIL_HEADER_INVALID`) before folding — interpolated
  data reaches `Subject`, and a break there injects headers. Refuse it, never strip it.

## Commands

```bash
bun test packages/mail
bun run --filter @ultimat3/mail typecheck
```

Gotchas:
- The registry erases `I` (`AnyMailDefinition`); `sendById` holds the package's only cast.
- No job driver configured ⇒ `send` delivers inline rather than dropping the message.
- Tests must not call `resetMails()` — template registration is module-level and shared.
- `driver-smtp.test.ts` runs a real `Bun.listen` SMTP server on loopback. The sealed test network
  covers `fetch` only, so this is allowed — and it is the only proof the socket, the chunk queue
  and the reply framing agree. Resend tests inject `options.fetch`; never unseal.
