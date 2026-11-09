# 01 — Release policy: the window counts from v31

> Part of [`overview.md`](overview.md). Depends on: none. Tier: `scripts/`, docs. Lands in sweep 0, before any breaking slice.

## Why
Owner ruling 2026-11-09: this plan is the last big change; breaking changes land on `main` now and ship together as **v31, the final major**. v30.0.0 shipped 2026-11-07 (`CHANGELOG.md:303`), so today's window would refuse v31 until 2027-02-05 and `X_BREAKING_ON_MAIN` would refuse every break. Only our own apps run Ultimate in production, so the window protects no one yet. It starts protecting adopters from v31.

## Files to change
- `scripts/lib/major-window.ts:11` — `WINDOW_OPENS_AT_MAJOR = 30` → `31`. The rest of the file (`:87`, `:116`, `:128`) keys off the constant.
- `scripts/lib/major-window.test.ts`, `scripts/release-window.test.ts` — fixtures dated against v30 move to v31; add: a v31 within 90 days of v30 passes; a v32 within 90 days of v31 is refused.
- `scripts/lib/release-due-rule.ts`, `scripts/lib/changelog-highlights.ts` — any `30` literal tied to the window reads the constant.
- `wiki/Stability.md` (rows at `:93-96`, the opening promise) — "from v31, at most one major per 90 days"; one line recording the 2026-11-09 ruling.
- `docs/architecture/19-cutting-a-major.md` — same number.
- `docs/architecture/guards.md` — regenerate: `bun run scripts/guards-doc.ts --write`.

## Steps
1. Change the constant, then fix every test it reds. No second constant, no override flag (axiom 1).
2. Update the two docs. Do not edit `docs/plans/2026/11/02/101-absorb-reinvented-patterns/42-adopt-stability.md` (a record).
3. `bun run changelog-check` on a branch carrying a `### Breaking` entry: green.

## Tests
- `bun test scripts/lib/major-window.test.ts scripts/release-window.test.ts`

## Done when
- A breaking PR to `main` passes `changelog-check` and the gate while the newest major is 30.
- After v31 is cut, the same checks refuse a v32 dated within 90 days.
