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
| `driver.ts` | `MailDriver` + memory/log/smtp/resend + the `setMailDriver` seam |
| `job.ts` | `sendMailJob`, `mailIdempotencyKey`, the envelope schema |
| `catalog.ts` | English source strings for `mail.*`. Data, not code |
| `html.ts` | escaping + `safeUrl`. The only place that builds an attribute |

## Rules

- `SendOptions.locale` is non-optional in the type. Never relax it, never default it.
- Text part is derived from blocks and must be non-empty (`X_MAIL_TEXT_MISSING`).
- No literal user-facing string in `templates/` or `layout.ts` — keys only.
- No hex outside `MAIL_TOKENS`. Base styling is inlined (clients strip `<style>`); dark mode is
  one `prefers-color-scheme` block keyed on short `data-x` role codes.
- Never format a date without `options.tz`.
- `X_NOT_IMPLEMENTED` is core's code — `errors.ts` registers titles behind `hasErrorCode`.
- New block kind: `MailBlock` + `blocks` + `htmlOf` + `textOf`, same commit.

## Commands

```bash
bun test packages/mail
bun run --filter @ultimat3/mail typecheck
```

Gotchas:
- The registry erases `I` (`AnyMailDefinition`); `sendById` holds the package's only cast.
- No job driver configured ⇒ `send` delivers inline rather than dropping the message.
- Tests must not call `resetMails()` — template registration is module-level and shared.
