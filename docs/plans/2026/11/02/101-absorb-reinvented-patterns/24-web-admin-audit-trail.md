# 24 — `/admin/audit` is a trail one can search and page

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 5 (`admin`).

## Why
Entry 101 is unreachable. `auditScreen` asks for the newest 100 and offers no parameter, link or filter (`admin/src/screen-system.tsx:14,21`), while the wiki calls it "the whole trail" (`wiki/Admin-Dashboard.md:130`). `AuditQuery` already takes `entity`, `actorId`, `changes` and keyset `before` (`admin/src/audit.ts:67`), and the row history card already pages (`admin/src/screen-resource.tsx:272-290`). "Who changed this last week?" cannot be answered on the screen that exists to answer it.
Two apps of twelve built their own browser: one adopter on this framework wrote a 200-LOC page plus 157 of tests at another path to get filters, and one other ships two filter components. The adopter filters on actor, subject, outcome and date range, and every one of those but outcome and date is already a query field. Which fields a *domain* audit row adds stays theirs.
The empty state is wrong too: `admin.audit.empty` reads "Nothing has been done to this row yet." on a screen about no row.

## Decisions
| Question | Answer |
|---|---|
| Second list engine? | no. `AuditLog` is not an `AdminResource`, and making it one needs a repo and invents CRUD verbs. Same native GET form and link idiom as the list (`admin/CLAUDE.md`, "A list's state is its URL") |
| A bad parameter | refused, 400 with `X_ADMIN_FILTER_INVALID` naming what the screen answers, as `list-request.ts`. Never the unfiltered trail |
| Date bounds | `since`, `until`: instants with an offset, or a bare date as that day's first instant in UTC, using `list-filters.ts:88`'s `instantOf`, exported. No admin invents a zone |
| Third-party `AuditLog` | two new optional query fields. A custom `entries` that ignores them would answer unfiltered, so the screen re-checks `outcome` and the bounds on each returned entry before drawing. Documented on the interface |
| CSV of the trail | no. An `AdminCustomPage` with `exportRows()` composes it; who may export is the app's |
| Saved views | killed: one adopter, and the URL already is the view |
| A tenant reading another's trail | unchanged: `orgId` is the actor's, never a parameter (`screen-system.tsx:20`) |

## Files to change
- `packages/admin/src/audit.ts:67` — `AuditQuery.outcome?: AuditOutcome`, `since?: string`, `until?: string`. `:190` memory `entries` filters on them.
- `packages/admin/src/audit-pg.ts:97` — `selectFor` binds `outcome = $n`, `at >= $n::timestamptz`, `at < $n::timestamptz`.
- `packages/admin/src/audit-request.ts` (new) — parse and build `?entity= &actor= &outcome= &since= &until= &changes=1 &before=`, the one parser; `historyCursorOf`/`historyCursorText` (`detail.tsx:196-199`) are reused for `before`.
- `packages/admin/src/screen-system.tsx:16` — filter form (zero JS, native GET), older link from `auditCursorOf`, each entity linked to its row when the resource is mounted and the actor may read it. Page size stays `AUDIT_PAGE`.
- `packages/i18n/src/catalogs/en.json:176` — `admin.audit.empty` becomes trail wording; new `admin.audit.empty-row` for the history card; new filter labels. `packages/admin/src/catalog-keys.ts`.
- `wiki/Admin-Dashboard.md:130`, `packages/admin/README.md`, `packages/admin/CLAUDE.md` (a rule row).
- `examples/dummy/apps/admin/app/admin/admin.ts` — its `defineAdmin` already has the default `memoryAuditLog()`; nothing to declare. Add one assertion to its admin test that a filtered URL answers 200.

## Steps
1. Query fields on both stores, with parity.
2. `audit-request.ts`, reusing `X_ADMIN_FILTER_INVALID` through `AdminFilterInvalidError`. No new code.
3. Screen: form, list, older link that carries the filters.
4. Split the empty keys; update whichever detail component reads the row wording.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_ADMIN_FILTER_INVALID` (existing) | an unknown parameter or outcome, or a date with no calendar day or no zone | the message names what `/admin/audit` answers; drop the parameter from the URL |

## Tests
- `audit.test.ts`: `outcome`, `since`, `until` on the memory log; `until` exclusive; `before` combined with a filter.
- `audit-pg.contract.test.ts`: the same cases on PGlite, one assertion list shared so the stores cannot differ.
- `audit-request.test.ts`: round trip; each refusal; `?org=` is unknown, so 400.
- `screen-home.test.ts`-style render test in a new `screen-audit.test.ts`: 101 entries draw 100 and an older link, whose page draws the last one (must fail today); a filtered older link keeps its filter; another org's entry is absent under `orgId`; a custom `AuditLog` ignoring `outcome` still draws only the asked outcome.
- `bun test packages/admin/src/screen-audit.test.ts packages/admin/src/audit-request.test.ts`.

## Semver
Minor. Additive query fields; the screen's old URL answers as before. `admin.audit.empty` changes text: an app overriding it for the row card moves to `admin.audit.empty-row`, noted in `CHANGELOG.md`.

## Done when
- Every entry is reachable by paging, filtered or not, in the actor's tenant only.
- `wiki/Admin-Dashboard.md`'s "whole trail" is true.
- `bun run verify` is green, and `bun run scripts/reference-app-gate.ts` holds its ratchet.
