# 38-ui-pickers — Dates, windows and bounded values

> Part of [`overview.md`](overview.md). Depends on: [`23-ui-data-table.md`](23-ui-data-table.md) (`listUrl`). Tier: 4 (`ui`), using tier 1 `time`; 5 (`cli` templates).

## Why
Every dashboard is "this metric over that window", and every back office filters by date. The kit has `Input type="date"` (`Input.tsx:17`) and nothing above it: no calendar, no range, no window control. `@ultimat3/time` already holds the arithmetic (`plainDate`, `plainDateRange`, `comparePlainDates`, `addPlainMonths`, `index.ts:102-121`) and has no view.
One adopter's window picker plus URL state is 267 LOC; a second wrote window parsing, a third wrote `metrics/range.ts`. Earlier "time range" kill was under a bar of adopter agreement; a window control is standard, and its presets are the app's data, not a convention we ship. Probe: `new Intl.Locale('en-US').getWeekInfo()` `firstDay: 7`, `'de'` `firstDay: 1`, so week start needs no table.

## Decisions
| Question | Answer |
|---|---|
| Native or custom | both, in order. Server and `(pointer: coarse)`: native `<input type="date">`, which wins on a phone. Pointer and script: same input plus a calendar popover. The input stays the value, so posts are identical |
| Value type | `PlainDate` strings for `DatePicker`/`DateRangePicker`. A date has no zone. `TimeRangePicker` deals in instants and **requires** `timeZone`: no ambient default |
| `Calendar` exported? | yes, it is usable inline (a booking page), and it is what the pickers render |
| Presets | caller's: `presets: { id, label, seconds \| from/to }[]`. No built-in list; "last 24 h" vs "this quarter" is business (axiom 8). The picker holds no fiscal calendar |
| URL state | `timeRangeUrl(url, { presets, default, ns?, timeZone })` composes `listUrl(url, { sorts: [], ns })`, building each link with its `href(change)`, so keep-other-params and drop-the-cursor is one rule, not a copy. A backwards or malformed custom window returns the default with `invalid: true`, and the picker says so |
| Auto-refresh choice | not here. A `Select` calling `visibleInterval`; a page control, not a window |
| `Slider` | yes, native `type="range"` with token paint, no thumb JS; a kit without one sends an agent to a div |
| Number stepper | killed: `Input` refuses a number wrapper on purpose (`Input.tsx`, locale separators); second way |
| Segmented | `Radio appearance="segmented"`: native radios, one prop, not a component |
| Time-of-day input | `Input type="time"` shipped |

## Components
| Component | Base | Keyboard | No script | Mobile | `examples/dummy` |
|---|---|---|---|---|---|
| `Calendar` | `role="grid"`, one tab stop | arrows, PageUp/Down month, Shift+Page year, Home/End week, follows `dir` | days as links with `hrefFor` | 44 px cells at 320 px | `runs/` |
| `DatePicker` | `<input type="date">` + `Popover` | input's, F4 or button opens, Esc returns focus | native | stays native | `feed/page.tsx` jump to a day |
| `DateRangePicker` | two date inputs + `Calendar` | same; second pick completes; `aria-selected` over the span | two inputs, GET or POST | two native inputs | `runs/` filter |
| `TimeRangePicker` | preset links + GET form of `datetime-local` | native | full | presets scroll in their box, custom in a `Drawer` | `runs/` health page |
| `Slider` | `<input type="range">` | native, label and output bound | native | thumb at `--touch-target` | `settings/page.tsx` |
| `Radio` segmented | native radios | native arrows | native | wraps | `settings/page.tsx` |

## Files to change
- `packages/ui/src/components/calendar-view.ts`, `Calendar.tsx`, `Calendar.module.scss` (new) — month grid, week start from `getWeekInfo` with `weekStart` prop as override and for an engine lacking it; roving by `stepDay`; min, max, `isDisabled`.
- `packages/ui/src/components/DatePicker.tsx`, `.module.scss`, `date-picker-view.ts` (new).
- `packages/ui/src/components/DateRangePicker.tsx`, `.module.scss`, `date-range-view.ts` (new) — pick order, swapped ends, span membership.
- `packages/ui/src/components/TimeRangePicker.tsx`, `.module.scss` (new).
- `packages/ui/src/time-range-url.ts` (new), over `list-url.ts`; `packages/ui/src/index.ts`.
- `packages/ui/src/components/Slider.tsx`, `.module.scss`, `slider-view.ts` (new).
- `packages/ui/src/components/Radio.tsx:17`, `Radio.module.scss` — `appearance`.
- `packages/ui/src/i18n-keys.ts`, `packages/i18n/src/catalogs/en.json` — `ui.date.*`, `ui.range.*`. Month and weekday names from `Intl.DateTimeFormat` with explicit `timeZone: 'UTC'` on a plain date: no catalog, no ambient zone.
- `packages/cli/src/templates/scaffold-dashboard-example.ts:129` — the dashboard reads its window through `timeRangeUrl`; `resource-page.ts` is untouched.
- `examples/dummy/apps/web/app/runs/`, `feed/page.tsx`, `settings/page.tsx`, `examples/dummy/x.manifest.json`.
- `scripts/ui-barrel-bytes.test.ts`; `packages/ui/README.md:254`, `packages/ui/CLAUDE.md`, `packages/ui/CATALOG.md`, `wiki/Interface-Rules.md`, `wiki/UI-Components.md`, `wiki/Timezones-And-Dates.md`.

## Steps
1. `calendar-view.ts`: weeks of `PlainDate`, 6 rows always so the box never jumps. DST and leap tests against `time`.
2. `Calendar`, server-rendered and correct with no effect run. `hrefFor` link mode or `onSelect` callback mode, a union.
3. `DatePicker`: first client render equals the server's input; an effect mounts the button only on `(pointer: fine)`.
4. `DateRangePicker`: `{ from, to }`, form names `fromName`/`toName`. Under `Popover`'s CSS positioning, no measure loop.
5. `timeRangeUrl`, then `TimeRangePicker`, which is links plus a form: 0 B in a static route.
6. `Slider`, `Radio` appearance, tokens only; `@supports` paint for the track fill.
7. Measure. Static stays 0 B. Each island figure stated in the diff (`bun run budget-raises`).

Motion: none in the grid; month change swaps at once, popover uses token durations.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_UI_INVALID_VALUE` (existing) | a non-`PlainDate` value, `min` after `max`, a preset with neither `seconds` nor `from`/`to`, a `Slider` `step` of zero | cause names the prop and the value |
| `X_TIMEZONE_INVALID` (existing, `time`) | `timeZone` not IANA | the existing fix; do not add a code |

## Tests
- Unit: `calendar-view.test.ts` (`de` Monday, `en-US` Sunday, 6 rows, `dir` arrow flip), `date-range-view.test.ts`, `time-range-url.test.ts` (hostile params default; backwards window `invalid`; cursor dropped; `ns` isolation; custom window round-trips across a DST day), `slider-view.test.ts`.
- `packages/ui/src/components/interaction.test.ts`: one tab stop in the grid; disabled day never lands the roving stop (`roving.ts`).
- `packages/cli/e2e/ui-date-pickers.e2e.test.ts` (browser): scripting off, a range posts; touch viewport keeps native; keyboard picks a range, Esc returns focus to the opener; 320 px cells.
- `packages/ui/src/ui-catalog.test.ts`: new keys reachable. Command `bun test packages/ui/src/components/calendar-view.test.ts`.

## Semver
breaking; lands in v30.
**Breaking, one row.** `UI_KEYS` gains keys. Upgrading: "Add `ui.date.*`, `ui.range.*` to any `Record<UiKey, string>`." Everything else is additive.

## Done when
- A runs page filters by a date range with scripting off, and with a calendar on a pointer device.
- `TimeRangePicker` without `timeZone` is a type error.
- A window in the URL survives reload, share and paging; changing it drops the cursor.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green; scaffold smoke green twice per shape.
