# 23 — Feature gaps: the last mechanisms most web apps need

> Part of [`overview.md`](overview.md). Depends on: [`21`](21-adapter-wiring.md) A (ports), [`20`](20-observability.md). Tier: per row. Two sweeps (12a, 12b).

## Rule
Each gap ships as a **factory over an existing primitive** (a `PRIMITIVE_FACTORIES` row) or an **adapter port** (an `ADAPTER_PORTS` row with a conformance suite). No ninth primitive, no business convention (axiom 8): mechanism the same for a bank and a blog.

Already shipped — not gaps (checked 2026-11-09): passkeys, MFA, OIDC, API keys, impersonation, S3 multipart, i18n, mail, notify, jobs/cron, outgoing webhooks (`jobs/src/webhook.ts`), admin, audit, flags, rate limits, cache tiers, realtime, tenancy, soft delete, CSV import/export, Postgres full-text search, sitemap/SEO.

## Gaps
| Sweep | Gap | Shape | Package (tier) | Est. files |
|---|---|---|---|---|
| 12a | GDPR subject export and erase | `personalData()` column marker; `accountExport(subject)` and `accountErase(subject)` factories returning a **job** that walks every entity carrying a marked column, tenant-scoped; export writes to storage | `entity` (2) marker, `jobs` (3) factories | 10 |
| 12a | Distributed lock | `withLock(key, fn, { ttl })` over the jobs `LeaseStore`, exported; a port | `jobs` (3) | 4 |
| 12a | Upload scanning | `UploadScanner` port in the pending→confirm step (`storage/src/attachment.ts:18-24` says scanning is the app's, but no hook exists); memory scanner that flags an EICAR string | `storage` (1) | 5 |
| 12a | Search backend | `SearchIndex` port; Postgres `tsvector` built in (today's `.searchable()`); `reindex` as a `backfill()` job; Meilisearch/Typesense written by the app | `entity` (2) port, `jobs` (3) reindex | 10 |
| 12a | Record history | `versioned()` entity option: append-only shadow table, `history(id)` read | `entity` (2), `db` (1) DDL | 8 |
| 12b | SMS | `SmsTransport` port + reference `smsChannel()` over notify `Channel`; memory transport | `notify` (4) | 5 |
| 12b | PDF render | `pdf()` factory returning an **action**, rendering a route through the CDP browser; the launcher moves from `testing/src/cdp-*` to a runtime home (`scraping`, tier 4, already drives CDP) | `scraping` (4) | 8 |
| 12b | Image variants | `variant(key, { width, format })` over the existing `ImageTransformDriver` (`seo`), cached in storage | `storage` (1) + `seo` (1) — one tier-1 home: put the factory in `storage`, take the transform driver as an argument | 5 |
| 12b | SAML SSO | `IdentityProvider` port beside OIDC; SAML response verification (XML-DSig) — **new-dependency decision** per `docs/idea/18-build-vs-wrap.md`: state build vs wrap in the PR | `auth` (2) | 12 |
| 12b | Payments mechanism | `webhookReceiver()` example over existing verification + a `ledger()` factory over a **job** posting balanced `Money` entries (no provider conventions) | `jobs` (3), `money` (1) | 4 |

## Files to change
Per row; each adds its `PRIMITIVE_FACTORIES` or `ADAPTER_PORTS` row, a README section, a wiki page section, a reference usage in `examples/dummy` (one idiomatic use, axiom: every primitive once), and its conformance suite where it is a port.

## Tests
- Each factory: unit test on memory + a live test on Postgres where it writes.
- GDPR: erase leaves no marked value in any table; export round-trips.
- Lock: two holders, one wins; TTL expiry hands over.
- SAML: signed fixture accepted; tampered, unsigned, wrong audience, replayed refused.
- `scripts/primitive-factories.test.ts` stays green (rows complete).

## Done when
- `examples/dummy` uses each new factory once and the app gate is green.

## Outcome (2026-11-10)
Done. All 10 rows shipped, and `examples/dummy` uses each factory once with its gate green.

- **Record history wasn't missing.** It already existed as `entity({ history: true })`, with its DDL in `packages/db` (`packages/entity/src/registry.ts:173`). The earlier "`versioned()` not built" was a false premise: the audit grepped for the word.
- **Shipped in #1043:** GDPR (`subjectExport`/`subjectErase` + `.personalData()`, not `accountExport`/`accountErase`), `withLock`, `UploadScanner`, `SearchIndex` + `reindex()`, SMS, `pdf()`, `variant()`, SAML (built, no dependency) and `ledger()`.
- **Added by the closing PR:**
  - the `history(table, id)` read (`packages/entity/src/history-read.ts`, `history-order.ts`), with one conformance case run on memory, PGlite and live pg
  - `fakeSamlIdentityProvider` in `@ultimat3/testing`

| Factory | Where `examples/dummy` uses it |
|---|---|
| `withLock`, upload scanner (`hold`), `variant()` | org avatars |
| `partitionBy`, `smsChannel` | `quota_alerts` |
| `history()` | `postRevisions` |
| SAML | `identityProviderRoutes`, tested against `fakeSamlIdentityProvider` |
| `ledger()`, `pdf()`, `reindex()`, `subjectExport`/`subjectErase` | as before (#1043) |

Defects found and fixed while adding the reference usages:
- `partitionBy` and row-security statements were missing from `GENERATABLE_FORMS`, so they showed as drift.
- The seed writer mishandled `Date` primary keys.
- Nullable `matches()` and other operators were judged with two-valued logic; they now use SQL's three-valued logic.
- Seed values fell outside the partition window.
- There was no SAML test IdP.
