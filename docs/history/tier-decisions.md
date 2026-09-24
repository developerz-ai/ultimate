# Tier decisions, one record per edge

Moved out of the root `CLAUDE.md` on 2026-09-23 (plan 101, slice 17 f): the root `CLAUDE.md` keeps one line per declared edge and links here. [`scripts/lib/tiers.ts`](../../scripts/lib/tiers.ts) is the executable table.

**`cli → scraping` was declared 2026-08-21, and moving `scraping` down to tier 4 instead was refused.** `x shot` drives a real browser and `@ultimat3/scraping` is the one package that can. Its real imports are `core`, `jobs`, `schema` and `storage` — highest tier 3 — so tier 4 *is* its floor, and the `admin → ui` argument above would say to move it and delete the exception. That argument does not apply here, because tier 5 is not a misplacement: [`packages/scraping/CLAUDE.md`](../../packages/scraping/CLAUDE.md) puts it at 5 to reserve room for `recover: 'agent'` to import `@ultimat3/ai` (tier 4), and a package at 4 cannot import a package at 4. That file named this edge before anything imported the package: it wrote that because `cli` is also tier 5, a CLI command driving a browser would one day need a declared `cli → scraping` edge in the table. A tier that is holding a position is not a hole; deleting it would trade a documented future capability for one fewer line in a table. **The edge was deleted in 22.0.0**, when `x shot` moved onto raw CDP (plan 101, slice 18 e) and the CLI stopped importing `@ultimat3/scraping`; `scraping` keeps tier 5 for the `recover: 'agent'` reason alone.

**`admin → ui` is gone, and `ui` moved 5 → 4, decided 2026-08-19.** The edge was justified on
composition grounds — "the admin dashboard *is* the ui kit" — which is true and was never the
reason it was needed: `ui` imports `core`, `i18n`, `money` and `time`, so tier **2** is the lowest
its real imports allow and tier 5 was two tiers too high. The exception existed only to undo that
placement. `ui` sits at 4 rather than at its floor so `render → ui` stays forbidden (both at 4),
which [`packages/render/CLAUDE.md`](../../packages/render/CLAUDE.md) requires — the static bundle graph
may not reach the design system, which is axiom 6. An exception line in an enforcement table is a
rule with a hole in it, and deleting the hole beats arguing for it.

**The FLOOR is enforced too, `As of 2026-08-22`.** `boundaries.ts` derives each package's floor from
its shipped imports and refuses a package sitting above that floor with no row in `FLOOR_ABOVE`
([`scripts/lib/tiers.ts`](../../scripts/lib/tiers.ts)) — `X_TIER_FLOOR_UNDECLARED`, which also fires on a
row whose reason is blank, because "there was a reason" is the documentation axiom 3 says does not
exist. The reverse is a build error too: a row for a package that has since reached its floor, or
for a name the tier table does not carry, is `X_TIER_FLOOR_STALE`. Until then the ceiling was the
only half checked, while that file's own comment claimed the floor was checked "by this file's own
rule, not by opinion".

**Nothing moved when the rule landed.** Every package above its floor already had the sentence in
its own `CLAUDE.md`; `FLOOR_ABOVE` collects them, and each states what moving the package DOWN
would **legalise** rather than why the current tier feels right — `policy`, `pwa`, `render`,
`scraping`, `ui`. `bun run boundaries --json` re-derives the set. `pwa` at its floor of 2 is the
clearest case: `render → pwa` becomes an ordinary downward import, the service-worker generator
joins the static bundle graph, and axiom 6 loses the build error both packages' `CLAUDE.md` rely on.

**`cli → testing` was declared 2026-08**, when `bun run boundaries` learned to follow relative specifiers. `packages/cli/src/serve.live.test.ts` had been importing `../../testing/src/sealed-network` with a comment saying the package specifier "is a sideways import the boundary check refuses" — an evasion the check could not see. `@ultimat3/testing` was already a runtime `dependencies` entry of `@ultimat3/cli`, so the manifest had crossed the edge all along; declaring it makes the rule enforce what shipping already assumed. `create-ultimate` sits above the table at tier 6 and its declared edge is its *only* permitted import.

**`core → schema` was declared 2026-08-27, and the reverse stays forbidden.** Five declarations
were duplicated on the core side — `CURRENCY_CODE_PATTERN`, `describeValue`, `charCount`,
`SCHEMA_ERROR_CODES`, `isIanaZoneName` — held equal by **394 lines of pin test in `@ultimat3/cli`**,
a tier-5 package pinning a tier-0 invariant that no rule required to exist. `describeValue` is what
prints *instead of* a rejected password, so the safety property of the framework's most
security-sensitive renderer rested on a 63-line behavioural pin at tier 5. The lower-tier
extraction option (b) has no home: `schema` already imports nothing, and there is nowhere below
tier 0 for a sixth package. `schema → core` stays forbidden **on its merits** — `t` is in every
bundle graph an app has — so the three copies going THAT way (`singleLine`, `ERROR_DOCS_URL`, the
`Symbol.for('ultimate.error')` key) remain, now pinned at tier 0 by
`packages/core/src/single-line-pin.test.ts`.

**The cost was measured, not argued** — axiom 6 makes it a measurement.
`bun build --target=browser --minify`, one entry per row:

| one import | before | edge only | edge + honest `sideEffects` |
|---|---|---|---|
| `UltimateError` from `core` | 6,362 B | 19,018 B | **7,352 B** |
| `useUi` from `@ultimat3/ui` | 15,583 B | 28,284 B | **16,593 B** |
| `moneyText` from `@ultimat3/ui` | 27,203 B | 26,838 B | **19,417 B** |

The edge ALONE triples a core-only chunk: importing schema's barrel with no `sideEffects` field
forces a bundler to keep every module it reaches, and `@ultimat3/schema` declared none.
`bun run side-effects` had already **measured** the package as having no import-time effect and
nothing had written it down; with `sideEffects: false` the edge costs ~1 kB on a chunk that did not
already carry schema, and `moneyText` — which always did, through `@ultimat3/money` — comes out
**7.8 kB smaller** because the duplicates are gone.

**`db` is tier 1, decided 2026-08.** It imports `core` and nothing else, so tier 1 is the lowest its real imports allow — and that is what lets `entity` (tier 2) hold its own Postgres driver (`postgresDriver()`) instead of exiling it to a tier-3 package. Two things would have been wrong: a second package owning `Driver`'s only production implementation (two places to look for "where rows live"), and `database()` callers importing the seam from one package and the driver from another. Same shape as `auth → db`.
