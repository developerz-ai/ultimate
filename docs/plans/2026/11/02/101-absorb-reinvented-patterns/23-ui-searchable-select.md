# 23-ui-searchable-select — Choosing one of many, by value

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 4 (`ui`).

## Why
A form choosing a customer, a country or a model needs a closed list of hundreds, with a label distinct from the posted value. The kit has no such control: `Select` is native and unsearchable (`Select.tsx`); `Combobox` is a free-text field whose `<datalist>` posts whatever was typed (`Combobox.tsx:1`), with `ComboboxOption` holding only `value` and `hint` (`combobox-filter.ts:8`). A half-typed name submits as typed.
Four adopters wrote this control: 461 LOC, 388 LOC, about 1,240 LOC with chips and remote search, and one more. The cause the earlier cut called unknown is recorded in one adopter's source: "a `<datalist>`, which cannot group rows or put a second column in one". All converge on one shape: native `<select>` without script, WAI-ARIA combobox with `aria-activedescendant` with it. One reuses the framework's `normalizeQuery`.

## Decisions
| Question | Answer |
|---|---|
| Second way beside `Combobox`? | no. Three questions, three controls: `Select` a short closed list; `SearchableSelect` a long closed list, value ≠ label; `Combobox` free text with suggestions. `Combobox` stays unchanged, the table goes in the README and `wiki/Interface-Rules.md` |
| `<Select searchable>` instead | no. Every `Select` island would carry the listbox: baseline `Select` 15,935 B against `Combobox` 33,371 B, this probe |
| Without script | the real `<select>` (`multiple` for many, `<optgroup>` for groups). Complete: a native post carries the same `name` and values |
| Hydration | first client render equals the server's `<select>`; an effect flips a `mounted` signal to the listbox, moving focus when the select held it. No mismatch |
| Matching | `normalizeQuery`, one rule; word-prefix then substring over label, description, keywords. `filterOptions` keeps its contract, a new ranker lives beside it and shares the normaliser |
| Too many options | `onSearch(query)`: caller loads and hands back `options`. `limit` (default `COMBOBOX_LIMIT`), "first N of M" spoken. Chosen values must stay in `options` |
| Touch | same listbox; field at the 16 px floor (`wiki/Interface-Rules.md:109`); rows at `--touch-target`; `scrollIntoView` on open, above the keyboard |
| Virtualised list | no: `limit` is the answer; a list of thousands is a field to type in |
| Option rendering | label + description line. A custom render prop is a look and defeats the no-script path |

## Files to change
- `packages/ui/src/components/SearchableSelect.tsx`, `.module.scss` (new) — the control.
- `packages/ui/src/components/rank-options.ts` (new) — `rankOptions`, a leaf over `normalizeQuery`, so `CommandPalette`'s `filterItems` ([`38-ui-commands.md`](38-ui-commands.md)) composes it and retains no listbox.
- `packages/ui/src/components/searchable-select-view.ts` (new) — `stepActive` over enabled options (`roving.ts` rule), type-ahead, `toggleValue`, adjacency of groups, ids.
- `packages/ui/src/components/SearchableSelectChips.tsx` (new) — removable chips for `multiple`; split by the 200-line target.
- `packages/ui/src/components/combobox-filter.ts:21` — `normalizeQuery` stays home; nothing else changes.
- `packages/ui/src/index.ts:240`, `i18n-keys.ts`, `packages/i18n/src/catalogs/en.json` — export; `ui.select.none`, `ui.select.more`, `ui.select.remove`, `ui.select.clear`; `ui.results.empty` reused.
- `packages/ui/src/components/interaction.test.ts`, `style-classes.test.ts` — wiring, classes.
- `examples/dummy/apps/web/app/settings/page.tsx:168` — the time-zone setting, a closed list today handed over as `timezones`: the idiomatic use. `examples/dummy/x.manifest.json` regenerated.
- `scripts/ui-barrel-bytes.test.ts` — retained modules and ceiling.
- `packages/ui/README.md:262`, `packages/ui/CLAUDE.md`, `packages/ui/CATALOG.md`, `wiki/Interface-Rules.md`, `wiki/UI-Components.md`.

## Steps
1. Shape: `SearchableSelect({ name, options, value, onChange?, multiple?, onSearch?, debounceMs?, limit?, placeholder?, id?, required?, disabled?, size?, class?, aria-label?, aria-describedby?, aria-invalid? })`. A union on `multiple` types `value` and `onChange`. `SearchableOption = { value, label, description?, group?, disabled?, keywords? }`. Takes `Field`'s control props directly.
2. Pure module, tested first. Keys: arrows, Home, End, PageUp, PageDown, Enter, Escape, Tab closes without picking, Backspace on an empty query removes the last chip.
3. Component. The input is `role="combobox"`, focus never leaves it; rows are `role="option"` with `tabindex="-1"`. Label association through `Field` (never a wrapping label: every option would land in the name). Hidden input(s) carry `name`. `form.reset` restores the original value.
4. Form binding: `useForm`'s `FormData` path works unchanged because the inputs are real.
5. Docs table, dummy, measure, raise the settings route's budget with `measured:` and `why:` (`bun run budget-raises`). Run `bun run --filter @ultimat3/ui catalog`.

No opening animation beyond the existing token durations, which reduced motion collapses.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_UI_INVALID_VALUE` (existing) | two options share a `value`; one group's options not adjacent; `value` names no option in `options` | cause names the value. Chosen values must be in `options` under `onSearch` |

## Tests
- `packages/ui/src/components/searchable-select-view.test.ts` (unit): `cafe` finds `Café`; disabled rows never active; rank order stable within a rank; type-ahead wraps.
- `packages/ui/src/components/interaction.test.ts` (fake DOM, real Solid): server render holds `<select name>` and no listbox; after the effect, focus preserved; picked label shown, value posted.
- `packages/cli/e2e/ui-searchable-select.e2e.test.ts` (browser): scripting off, a form post carries the value; scripting on, typing a non-option then blurring posts the previous value, never the text; 390 px viewport; role and name queries for the combobox and options. Command `bun test packages/ui/src/components/searchable-select-view.test.ts`.
- `scripts/ui-barrel-bytes.test.ts`: importing `Select` retains no `searchable-select-*` module.

## Semver
breaking; lands in v30.
**Breaking, one row.** `UI_KEYS` gains keys, so the exported `UiKey` union widens. Upgrading: "Add `ui.select.*` to any `Record<UiKey, string>`." The component is additive; `Combobox` and `Select` change nowhere.

## Done when
- With scripting off a page posts the chosen value; with scripting on free text can never be posted.
- `Select`'s island bytes do not move.
- The time-zone setting in `examples/dummy` is usable by keyboard only and on a 390 px viewport.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green.
