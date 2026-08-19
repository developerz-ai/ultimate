# @ultimat3/mail — agent notes

**Tier 4** (`scripts/lib/tiers.ts`). May import `core`, `schema`, `i18n`, `time`, `money`, `jobs`; never `auth`, `http`, `ui`, `render`. **Zero external deps** — no nodemailer, no MJML, no CSS library.

## Boundary

| File | Single responsibility |
|---|---|
| `mail.ts` | `defineMail`, the registry, `send` / `sendById` / `renderMessage` |
| `templates/` | the six framework mails, as data |
| `blocks.ts` | the template vocabulary: `MailBlock`, `blocks`, `MailTemplate`, `TemplateArgs` |
| `render.ts` | blocks → HTML **and** text, plus the layout call and the footer slots |
| `layout.ts` | `MAIL_TOKENS` (light + dark), the 600px table shell, layout registry |
| `driver.ts` | `MailDriver` + memory/log/unconfigured + `resultFor` + the `setMailDriver` seam |
| `driver-env.ts` | `selectMailDriver`: which transport an environment installs, and nothing else |
| `header-safety.ts` | `assertHeaderSafe`: the CR/LF gate on a `MailMessage`, so every driver refuses the same one |
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
  never a `retryable` guess. **`retryable` becomes the error's `retry` classification, and
  `X_MAIL_SEND_FAILED` is REGISTERED** (`registerErrorRetry`, `As of 2026-08`) — both halves, because
  `classifyThrown` honours a per-instance `terminal` only for a registered code. It rode in `meta`
  alone and nothing read it, so `sendMailJob` spent all five attempts on a 401 or a 550 hard bounce
  while its own `cause` said retrying cannot help. `errors.test.ts` asserts it through the QUEUE's
  `nextRetryForError`, never against the table.
  `stage` is the `SendStage` union in `errors.ts`; a new step goes there first.
  The transient set is 4xx over SMTP, and 408/409/425/429 + 5xx over HTTP — that HTTP set
  lives in `RETRYABLE_STATUSES` (`driver-resend.ts`) and is edited there, never restated.
- A transport is selected from the environment by `selectMailDriver`, never from an `app.config.ts`
  field — nothing loads that file's contents at runtime, so a `mail:` config block would be a
  setting no boot could read. Two credentials at once is refused, not resolved: mail leaving by
  the wrong provider is not a failure anyone sees. The credential never reaches a printed string.
- **No credential is answered by the ENVIRONMENT, and outside development it REFUSES** (`As of
  2026-08`). It answered the memory driver everywhere, including production — so a deploy that
  configured no transport reported `accepted` for mail that never left the process, with no error
  anywhere. `createUnconfiguredDriver` rejects every send with `X_MAIL_CREDENTIAL_MISSING` instead.
  Three parts of that are decisions, not details. It is a **driver and not a boot refusal**, so an
  app that sends no mail still deploys and one that does fails on the path that needed the
  capability. `staging` refuses too, because staging exists to fail the way production fails —
  which is `isLocal()`'s own rule, read from **core** rather than restated here, so mail and storage
  cannot disagree about which deploy this is. And it is its **own code**: `X_MAIL_DRIVER_UNAVAILABLE`
  is a developer who never called `setMailDriver`, this is an operator who set no variable, and one
  code for two audiences is a `fix:` that is wrong half the time.
- **The CR/LF header rule is a property of the MESSAGE, checked at `renderMessage` and again in
  `sendMailJob`** (`As of 2026-08`). `mime.ts` held the only copy, so a subject an SMTP deploy
  refused was accepted by memory in dev and by Resend in staging — the same app, three answers.
  `mime.ts` keeps its gate and is not redundant: it also covers `From`, `Date` and `Message-ID`,
  which the transport mints and no message-level check can see. The job's copy exists because a
  queue row is not necessarily one this process rendered, and `mailMessageSchema` proves a payload's
  SHAPE only. A driver reached DIRECTLY through `mailDriver().send(handBuilt)` is off that path —
  `assertHeaderSafe` is exported for a custom driver that wants the same gate.
- **The SMTP `Message-ID` is content-derived, so every attempt of one send presents the same one**
  (`As of 2026-08`). It was a fresh `nanoid` per attempt, and a send that times out after `DATA` is
  classified retryable — so the retry was a second email to every mailbox that would otherwise have
  collapsed it, while `SendResult.idempotencyKey` claimed one message on both transports. This
  narrows the gap and cannot close it: SMTP has no idempotency protocol, so the header is an
  opportunity for the receiving side and never a guarantee, where Resend's `Idempotency-Key` is
  enforced by the provider. That asymmetry is a transport DIFFERENCE and is pinned as one.
  `mailMessageIdToken` is a one-way digest of `mailIdempotencyKey`, never the key itself: the key
  holds the recipient list, bcc included, and a `Message-ID` is visible to all of them.
- **`driver-parity.test.ts` asserts every driver's behaviour in ONE test.** Both production drivers
  run for real — SMTP over a fake `SmtpStream`, Resend over an injected `fetch` — so a case compares
  what each did rather than a proxy for it, and neither side can move alone. The memory driver joins
  the cases about the MESSAGE and none about a wire: it dials nothing, maps no status and carries no
  idempotency header, and that is documented difference, not defect.
- `Bcc` is an envelope field. It reaches `RCPT TO` and Resend's body, never a header.
- Recipient addresses stay out of logs and out of error text we write ourselves; the server's own
  reply is passed through verbatim, and that is where the refused address comes from.
- Every header value is checked for CR/LF (`X_MAIL_HEADER_INVALID`) before folding — interpolated
  data reaches `Subject`, and a break there injects headers. Refuse it, never strip it.
- Every ENVELOPE address is checked the same way and separately (`X_MAIL_ADDRESS_INVALID`,
  `envelope-address.ts`, called by `smtpDeliver`). Two wire formats, one gate each: `bcc` is not a
  header, so the header gate never sees it, and on the inline send path no schema does either — a
  `bcc` of `ops@x.test\r\nRCPT TO:<evil@y.test>` relayed mail over the app's own authenticated
  connection. The refused set is control characters plus `<` and `>`; a space is deliberately
  allowed (quoted local-parts) and non-ASCII is SMTPUTF8's question, not this check's.

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
