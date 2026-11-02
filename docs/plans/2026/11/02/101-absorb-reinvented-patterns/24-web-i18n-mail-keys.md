# 24 — A catalog key only a mail or a push names is seen by the gate; a mail with a miss is not sent

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 1 (`i18n`, generic option only), 4 (`mail`), 5 (`cli`, the shapes).

## Why
The gate is green and a customer receives raw keys. `extractKeys` matches `t`, `$t`, `translate` only (`i18n/src/extract.ts:53`), so `subject:`, `blocks.*('key')`, `titleKey:` and `bodyKey:` are invisible, and such keys read as `unused`, which the wiki calls deletable. A mail is the one surface where a loud miss cannot be taken back.
Probe, 2026-11-02: source with `defineMail({ subject:'mail.r.subject', … blocks.paragraph('mail.r.body') })`, `es-co` catalog without either key.
`usages ["a.b"]` · `audit ok true` · `send … accepted ["a@x.test"]` · `delivered subject ⟦mail.r.subject⟧ text ⟦mail.r.body⟧`.
One adopter has 29 mails and 315 such keys. None is missing today, held only by its own parity tests.
`wiki/I18n.md:127` says a key one catalog holds alone is a missing key. The probe shows it is not, unless source names it. Dynamic keys (`t(\`plans.${x}\`)`) share this hole.

## Decisions
| Question | Answer |
|---|---|
| Scan or render templates? | scan: a template needs data, and sampling a schema gives a second walker. `subject` is a literal in the declaration |
| Framework scan | unchanged. `scripts/lib/i18n-scan.ts:41` also calls `extractKeys`, and `mail.*` lives in `mail/src/catalog.ts`, not `catalogs/en.json`. So the new shapes are an option `scanSource` passes, not `DEFAULT_CALLEES` |
| Who knows mail's API | `cli`, tier 5. `i18n` is tier 1 and must not name `blocks`, `subject` or `defineMail`. It learns two generic options: more callees (it has them, `extract.ts:47`) and literal properties. `cli` already sits over both |
| Key-set parity | every key of the reference locale must exist in each other locale, compared by plural stem (`definesKey`, `extract.ts:161`), so `pl`'s `_few` and `ja`'s lone `_other` still pass. Measured on the three multi-locale catalogs among eight apps: 0 lacking, 0 extra, so no tracked app goes red |
| Refuse at `send()` or `renderMessage()`? | `send()`. `renderMessage` is what a preview calls and a preview should show the miss (`mail/src/mail.ts:182` draws the same line) |
| Byte scan for `⟦`? | no: user data may hold one. The renderer records what it resolved: `!t.has(key)`, or a `placeholdersOf` slot with no own var |
| Push at runtime | gate only. `renderPushPayload` keeps its `warnings`; a push is replaceable by `tag`, a mail is not |
| Required plural categories per locale | no: `Intl` lists `many` for `es` and it reads fine through `_other`; refusing it is noise on every `es` app |

## Files to change
- `packages/i18n/src/extract.ts:45,61` — `ExtractOptions.properties?: readonly { name: string; whenFileContains?: string }[]`: a literal value of that property is a usage, a non-literal goes to `dynamic`. Nothing about mail.
- `packages/cli/src/i18n-app-key-shapes.ts` (new) — `APP_KEY_SHAPES`: callees `t`, `$t`, `translate` plus `blocks.heading|paragraph|button|callout|detail` (the key is the first argument of each, `mail/src/blocks.ts:30-44`), properties `titleKey`, `bodyKey`, and `subject` when the file contains `defineMail(`.
- `packages/i18n/src/extract.ts:110` — `AuditInput.reference?: Locale`; `missing` becomes used plus reference stems.
- `packages/cli/src/i18n-audit.ts:38` — `scanSource` passes `APP_KEY_SHAPES`; the audit passes `reference: DEFAULT_LOCALE`.
- `packages/cli/src/i18n-locale-parity.ts:57` — comment now true; no logic change.
- `packages/mail/src/render.ts:53-62` — one resolver records misses; `RenderedMail.misses`, dropped before the message leaves.
- `packages/mail/src/mail.ts:183` — `send()` throws before the transform; terminal in `registerErrorRetry`.
- `packages/mail/src/errors.ts` — the new code.
- `wiki/I18n.md:113,121,127`, `wiki/Mail.md` rules table, `packages/i18n/CLAUDE.md`, `packages/mail/CLAUDE.md`, `packages/mail/README.md`, `wiki/Upgrading.md`.

## Steps
1. The generic option with `extract.test.ts` cases, then the shapes in `cli`; run `bun run scripts/i18n-catalog.ts` to prove the framework scan did not move.
2. Reference-set parity in `auditCatalogs`. `x i18n sync` already adds these (`missingFrom`, `i18n-audit.ts:218`).
3. Record misses in `render.ts`; refuse in `send()`. `bun run new-error-code X_MAIL_KEY_MISSING --package mail --title '…' --cause '…' --fix 'x i18n sync <locale>' --off-socket`.
4. Run the gate on both tracked apps; any finding is a real gap, so fix the catalog.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_MAIL_KEY_MISSING` (new) | `send()` rendered a key or slot with no value in that locale; nothing leaves | `x i18n sync <locale>`, then translate the keys in `meta.keys` |
| `X_CATALOG_MISSING_KEYS` (existing) | now also a mail or push key, or a reference key the locale lacks | `x i18n sync <locale>` |

## Tests
- `i18n/src/extract.test.ts`: a declared property, with and without `whenFileContains`; an interpolated key is `dynamic`.
- `cli/src/i18n-app-key-shapes.test.ts`: each mail shape over real `defineMail` source; every member of `blocks` that takes a key is listed, so a new block reds here; `subject:` in a file without `defineMail(` is not a key.
- `i18n/src/extract.test.ts`: reference parity with plural stems (`ja`, `pl`).
- `cli/src/i18n-audit.test.ts`: a mail-only key absent from `es` is a finding, and is no longer `unused` in `en`.
- `mail/src/mail.test.ts`: missing key and missing var refuse with an empty outbox; a value containing `⟦` from data still sends; `renderMessage` still returns the miss. Must fail before the change: the probe above is its first version.
- `bun test packages/i18n packages/mail packages/cli/src/i18n-audit.test.ts`.

## Semver
Breaking. Upgrading: "`x verify` reports keys only a mail or a push names, and any `en` key another locale lacks: run `x i18n sync <locale>`. `send()` refuses a mail with an unresolved key (`X_MAIL_KEY_MISSING`), including a framework mail in a locale that has not translated `mail.*`."

## Done when
- The probe prints a finding, and `send()` throws with an empty outbox.
- `bun run scripts/i18n-catalog.ts` output is unchanged.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` are green.
