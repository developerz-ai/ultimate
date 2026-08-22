# 05 — Tier 4: render, pwa, mail, manifest, ai, ui

> Part of [`overview.md`](overview.md). Depends on: 01 (`canonicalJson` exists already). Tier: 4.

## Files to change
- `packages/render/src/html.ts:140` — `name.startsWith('on')` is case-sensitive; `:143` and `:155` fold case. **Proven**: `ONERROR="alert(1)"` is emitted live. Reach: an app spreading attacker-chosen keys into JSX.
- `packages/render/src/html.ts:160` — attribute **name** never validated: `{ 'x onmouseover=alert(1) y': 'ok' }` → ` x onmouseover=alert(1) y="ok"`. **Proven.** Prior sweep's latent Low; the general form of the line above.
- `packages/render/src/html.ts:32-34` — `escapeAttribute` duplicates `packages/seo/src/xml.ts:17`; `render` already imports `seo`, and `packages/pwa/CLAUDE.md:20` names seo's as the one escaper.
- `packages/render/src/islands.ts:58-61` — `formatBytes` with no `mb` branch; `packages/pwa/src/precache.ts:123` has one; a 5 MB route reads `5120kb` in `X_BUDGET_EXCEEDED` and `5mb` in the precache warning. `ui`'s `file-input-view.ts:88` is a different (locale-aware) function and stays.
- `packages/render/src/registry.ts:337-370` — `matchRoute`/`RouteMatch` exported, zero consumers; `packages/http/src/stages.ts:164` is the live matcher. Which one dies → `12-decisions.md`.
- `packages/render/CLAUDE.md:73` — "ui (tier 5, upward)" — ui is tier 4; the rule holds (same tier, not a declared edge).
- `packages/mail/src/driver.ts:104` — `createMemoryDriver().send` stamps `at: new Date()`; the one unseamed clock in the package; `SentMail.at` is what `lastTo()` and the `/_x` panel order on.
- `packages/manifest/src/build.ts:104-115` (`canonical` + `sortKeys`) and `packages/ai/src/prompt.ts:165-173` (`stableJson`) — third and fourth canonical serialisers; `packages/core/src/canonical-json.ts` says "never add a fourth copy". `manifest`'s feeds `buildId` and the contract-diff equality (`diff-operations.ts:26,29`, `diff-work.ts:26,45,121`, `diff-routes.ts:91`), so a `-0`/`NaN`/`Date` fold can make a breaking change diff as no change. `manifest`'s `canonical` is a barrel export (`index.ts:13`) → breaking.
- `packages/pwa/src/version-skew.ts:171` — `updateSignal` has no runtime caller; `packages/cli/src/cmd-deploy.ts:150` names it as the wire behind `x deploy --critical`. Decision → 12.
- `packages/admin/src/inert-jsx.ts:36-68` vs `packages/ui/src/jsx-probe.ts:33-66` — two `depth`/`saved` counters over one `globalThis.React` descriptor; `admin → ui` is a legal downward import.
- `packages/mcp/src/validate-args.ts:152` — `new RegExp(pattern)` per call; `packages/schema/src/validators.ts:90` memoises.

## Steps
1. `attributePair`: refuse any name not matching `/^[A-Za-z_:][-A-Za-z0-9_:.]*$/` (return `null`, the established refusal at `:157`), then `name.toLowerCase().startsWith('on')`.
2. Delete `html.ts:32-34`; `import { escapeAttribute } from '@ultimat3/seo'`. Keep `escapeText`, `escapeRawTextContent`, `escapeJsonContent`.
3. Move `formatBytes` (1024-base, `b/kb/mb/gb`) to `@ultimat3/core`; delete render's and pwa's copies.
4. `createMemoryDriver(clock = systemClock)`, `at: clock.now()` — mirror `packages/scraping/src/clock.ts:18`.
5. `manifest/build.ts` and `ai/prompt.ts`: call `canonicalJson`; delete the local copies; remove `canonical` from `manifest`'s barrel (`BREAKING —`). Before landing, rebuild `examples/dummy`'s manifest twice and assert `buildId` is stable across the change *for the same input* — it may legitimately change once.
6. Export `probe`/`unprobe` from `@ultimat3/ui`; `admin/inert-jsx.ts` keeps `nodesOf`/`shallowNodes`/`renderNodes` and calls ui's install/restore.
7. `validate-args.ts`: memoise compiled patterns per tool (a `WeakMap<ToolSpec, Map<string, RegExp>>`).
8. Fix `packages/render/CLAUDE.md:73` wording.

## Tests
- `packages/render/src/html.test.ts` — table over `onclick/ONCLICK/OnClick/ONERROR` → `null`; `'a b=c'` → `null`; existing lowercase cases unchanged.
- `packages/core/src/format-bytes.test.ts` — `5 * 1024 * 1024` → `5mb`; render's `X_BUDGET_EXCEEDED` message test updated.
- `packages/mail/src/driver.test.ts` — under an injected clock, `SentMail.at` equals `clock.now()`.
- `packages/manifest/src/build.test.ts` — two contracts differing only by `-0` vs `0` in a default produce different `contentHash`; the diff reports the change.
- `packages/ai/src/prompt.test.ts` — same shape for a prompt id.
- `packages/admin/src/inert-jsx.test.ts` — nested install from admin then ui then restore leaves `globalThis.React` as it was.
- Command: `bun test packages/render/src/html.test.ts packages/mail packages/manifest/src/build.test.ts packages/admin/src/inert-jsx.test.ts`.

## Done when
- Tests fail-then-pass; `bun run boundaries` green (render → seo, admin → ui, render/pwa → core); CHANGELOG row for the `canonical` removal.
