# 09 — render, pwa, ui

> Part of [`overview.md`](overview.md). Depends on: 01, 03. Tier: 4. Path-disjoint from 10.
> Citations for `ui` rows are the corrected ones in [`findings/sweep-3-verify-tier-4-5.md`](findings/sweep-3-verify-tier-4-5.md).

## Files to change
| Where | Change | Row |
|---|---|---|
| `packages/ui/src/components/qr-matrix.ts:86-99`, `:111-117`, `:161-164`, `:200-206` | four placement fixes: no second separator ring; skip alignment centres over finders; `if (right === 6) right = 5`; second format copy untransposed, dark module kept | `s2-ui #1` (REPRODUCED) |
| `packages/ui/src/components/DataTable.tsx:140-155` | branch inside the returned JSX, as `AsyncRegion.tsx` (`{content()}`) | `s1-t4 #14` (REPRODUCED) |
| `packages/ui/src/theme/theme.ts:44-46` | `resolveTheme` reads `data-theme` from the document when nothing is stored | `s1-t4 #12` |
| `packages/ui/src/theme/brand.ts:64-78` | a role overridden in light only re-emits the shipped dark channels inside the dark media block | `s2-ui #4` |
| `packages/ui/src/form/form-binding.ts:155` | `validate` inside the `try` | `s1-t4 #13` |
| `packages/ui/src/components/CommandPalette.module.scss:6,24,33`, `Tooltip.module.scss:12-13,39`, `Popover.module.scss:44-47` | centring without a physical translate beside a logical inset | `s2-ui #3` |
| `packages/ui/src/components/Popover.module.scss:26-34,50-58` | the align rule resets only the align-owned property | `s3-t45` New 1 |
| `packages/ui/src/a11y.ts:36-39` | `useId` through the `SolidRuntime` seam with a per-island prefix | `s2-ui #5` (narrowed) |
| `packages/ui/src/components/Textarea.tsx:53` | the leading newline on the server only; `.value` on the client | `s2-ui #6` (REPRODUCED) |
| `packages/ui/src/components/relative-time-view.ts:36-39`, `bar-chart-view.ts:53`, `link-target.ts:22`, `Meter.tsx:52-53`, `Popover.tsx:66`, `Tabs.module.scss:22`, `Dropzone.module.scss:28-29`, `FileInput.module.scss:54-55`, `Dropzone.tsx:79-80` | promote after rounding; width clamped ≥ 0; `URL`-parsed external test; clamped ARIA values; `aria-controls` only while mounted; logical indicator; direct opacity; rejected files not handed on | `s2-ui` lows, gaps |
| `packages/ui/src/toast/toast-state.ts:98` | `\0` escapes, not raw NUL bytes | `s1-t4` low |
| `packages/ui/src/icons/build-icons.ts:30,72` | non-JSON body and non-array node → `X_UI_INVALID_VALUE` | `s2-ui` low |
| `packages/ui/src/theme/inline-script.ts:5-8`, `packages/ui/CLAUDE.md:34`, `a11y.ts:31-33` | stale "removed in 21" / "no client runtime" text | `s1-t4` low, `s3-t45` New 3 |
| `packages/render/src/render-isr.ts:187-229` | regeneration through `createSingleFlight` with `deadlineMs` | `s2-con #9` |
| `packages/render/src/render-isr.ts:149`, `:340-352` | pattern fallback picks the most specific match, not the first | `s1-t4` low (REPRODUCED) |
| `packages/render/src/duration.ts:27` | `'0s'` → `null`, as the number arm (`:21`) | `s1-t4 #4` |
| `packages/render/src/navigation.ts:125,127,139`, `navigation-history.ts:37-43` | restore `entryOf(history.state)` before the first `saveScroll()`; close the channel on `pagehide` | `s2-ui #2` |
| `packages/render/src/navigation-rules.ts:101`, `:116` | `hashOnly` tests the href; an unparsable href is a coded refusal | `s1-t4` low |
| `packages/render/src/css-modules.ts:84,151`, `:316` | scope classes in selector preludes only; the suffix hashes compiled CSS or the root-relative path | `s2-ui` low |
| `packages/render/src/static-path.ts:13,48`, `render-static.ts:120`, `route.ts:302,315`, `modes.ts:87,94`, `render-stream.ts:119-120` | coded refusals; `renderCauseValue`; the hole id escaped as `holeMarker` (`:57`) does | `s1-t4` low |
| `packages/render/src/navigation.ts:402-405`, `:277-278`, `navigation-dom.ts:75-78` | CRLF-normalised form body; aborted-navigation sheets owned; a stale transition does not clear `animating` | `s2-ui` low |
| `packages/pwa/src/route-rules.ts:90`, `:98-110`, `:105` | a personal page in `last-member` routes to `pages`; patterns from `encodeURI`'d segments; a catch-all matches its bare prefix | `s1-t4 #15, #16`, gaps |
| `packages/pwa/src/manifest.ts:160` | `display_override` follows `display` | `s1-t4` low |
| `packages/pwa/src/push.ts:175`, `:195-198` | non-JSON payload inside `waitUntil`; off-origin `notificationclick` URL refused | `s1-t4` low, `s2-sec L4` |
| `packages/pwa/src/service-worker.ts:280-281` | the install fill compares the build header (`seenBuild`, `:389`) | `s2-con` low |

## Steps
1. QR: pin one published matrix per version 1–3 and a decode-and-compare of codewords. `formatInfoBits`, `buildCodewords`, `applyMask` are correct — do not touch them. `qr-encode.test.ts:18` currently cannot fail on any of the four.
2. ISR `attach()` is `cli` (slice 12); this slice only makes the controller safe once attached — the deadline and the fallback order.
3. RTL: one sass-probe test (`packages/ui/src/sass-probe.ts`) asserting no `translate(-50%` beside `inset-inline-start` in any component sheet — the convention's build error. Then an `e2e` screenshot under `dir="rtl"` at 390 px for the palette.
4. `useId`: verify `islands.sharedChunks: true` before choosing the prefix source (`s3-t45` could not).
5. Budgets: these fixes add bytes to islands. `bun run budget-raises` — raise by the measured amount, number and reason in the same diff (`X_BUDGET_RAISE_UNSTATED`). Do not trim a fix to hold a figure.

## Tests
- `packages/ui/src/components/qr-encode.test.ts`, `DataTable.test.tsx`, `interaction.test.ts`, `style-classes.test.ts`, `theme/theme.test.ts`, `theme/brand.test.ts`, `form/form-binding.test.ts`, `a11y.test.ts`.
- `packages/render/src/render-isr.test.ts` (injected scheduler), `duration.test.ts`, `navigation.test.ts`, `css-modules.test.ts`.
- `packages/pwa/src/route-rules.test.ts`, `service-worker-pages.test.ts`, `manifest.test.ts`, `push.test.ts`.
- `bun test packages/ui packages/render packages/pwa`; `bun run verify --only e2e,budgets`.

## Owned elsewhere
- `packages/render/src/navigation-rules.ts:249-250` (non-http(s) load) — 2026-09-28 plan, slice 05.
- Unused `pwa` exports, the inert `push` capability (`s2-arch M5`) — slice 15.

## Done when
- A second, independent decoder reads `encodeQr` output for versions 1–3.
- A `DataTable` leaves its error state when the signal clears.
- A tag-only ISR page whose render hangs frees its slot at the deadline.
- `bun run verify` `budgets`, `e2e`, `seo` green; both tracked apps' gates green.
