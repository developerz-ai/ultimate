## What changed

<!-- One or two lines. The diff shows how; say why. -->

## Checklist

- [ ] `x verify` is green (`bun run scripts/verify.ts --json` at the repo root)
- [ ] **Tier boundaries respected** — `bun run scripts/boundaries.ts` passes; no new sideways or
      upward import, and any new entry in `scripts/lib/tiers.ts` says why in the table
- [ ] **Tests added** next to the source as `<file>.test.ts`, and they would catch a real
      regression (no `expect(true).toBe(true)`)
- [ ] **Errors are instructions** — every new throw is an `UltimateError` subclass with a stable
      `X_*` code, a cause, and an exact fix command. No bare `Error`
- [ ] **`--json` everywhere** — every new command, script, and error has a machine-readable form
- [ ] **i18n keys added** — no hardcoded user-facing string; new keys exist in every catalog
- [ ] **No raw colours** — semantic tokens only, in every component and stylesheet
- [ ] **Money is integer minor units**, time is stored UTC and formatted with an explicit IANA
      time zone
- [ ] **No `any`**, no default exports, files under ~200 lines
- [ ] Public API changes are re-exported explicitly from `src/index.ts` and documented in the
      package README

## Error codes

<!-- List every X_* code this PR adds or changes, with its fix line. `none` if there are none. -->

| Code | Cause | Fix |
|---|---|---|
| | | |

## Verification

```
$ x verify
```

<!-- Paste the output. If a step is skipped, say why. -->
