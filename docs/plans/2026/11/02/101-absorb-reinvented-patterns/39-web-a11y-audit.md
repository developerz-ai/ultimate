# 39 — Every e2e page audited by the browser's own accessibility tree

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 5 (`testing`, `cli`).

## Why
A button with only an icon and an image with no `alt` ship green: no step in `x verify` asks. Four apps across two repositories wrote this audit. An engine is a new dependency, and the browser already computed the answer: `Accessibility.getFullAXTree` is the tree a screen reader gets, after ARIA, label association and `aria-hidden` pruning. `cli/src/cdp-shot-a11y.ts:37` reads the same tree for one selector at a time and nothing judges it.
Recorded objection: existing apps opt in by hand, against axiom 3. Answer: no opt-in. Every `e2eTest` audits, through the one driver, so scaffolds, both tracked apps and existing apps get it with no line written.

## Probe, 2026-11-02
Full tree of a 51-node fixture: **30.5 ms**, one round trip. Role spellings printed by the browser:

| Markup | Role | Type | Empty name means |
|---|---|---|---|
| `<button>`, `role=button` | `button` | role | violation |
| `<a href>` | `link` | role | violation |
| `<input type=text>`, `<textarea>` | `textbox` | role | violation |
| `<input type=search>`, `role=searchbox` | `searchbox` | role | violation |
| `<select>`, `role=combobox` | `combobox` | role | violation |
| checkbox, radio, `role=switch` | `checkbox`, `radio`, `switch` | role | violation |
| range, number | `slider`, `spinbutton` | role | violation |
| `role=tab`, `role=menuitem` | `tab`, `menuitem` | role | violation |
| `<img>`, `role=img`, `<svg role=img>` | **`image`, never `img`** | role | violation |
| `<h1>` | `heading` | role | violation |
| document | `RootWebArea` | internalRole | no `<title>` |
| `<iframe>` | `Iframe` | internalRole | violation |
| `<summary>` | `DisclosureTriangle` | internalRole | violation |

`<img alt="">` is absent from the unignored tree, so decorative images pass with no rule. An `aria-hidden` subtree is pruned, so `aria-hidden` + `tabindex=0` needs a page probe. A `<div onclick>` is `generic` with no signal: `guard-semantic-interactive.ts` owns it. `role=option` outside a listbox did not appear: not in the table.

## Decisions
| Question | Answer |
|---|---|
| When | after every `goto` settles, and at the end of each test body, so an opened dialog counts. Findings collected and thrown at the end |
| Rules | the table, plus `<html lang>` present and no focusable element under `aria-hidden` (one `evaluate`). Contrast is the token system's. Heuristic rules (heading order, landmarks) are out: an engine's disputes, not a gate's |
| Scope of refusal | per test, reasoned: `e2eTest(name, body, { a11y: { allow: [{ role, selector, because }] } })`. `because` required, non-blank. No global switch: an option off by default or on with a global off is the objection again |
| Port | `E2eBrowserPage.accessibilityTree?()`, optional as `offline` is (`e2e-page.ts:34`); a port without it refuses by name, never skips silently |
| One reader | `toAxNode` moves to `testing/src/ax-node.ts`; `cli/src/cdp-shot-a11y.ts` imports it over the declared `cli → testing` edge |
| No browser | the `e2e` step already reports SKIPPED; nothing new |

## Files to change
- `packages/testing/src/e2e-a11y.ts` (new) — role table, `auditTree`, the in-page probe, finding rendering.
- `packages/testing/src/ax-node.ts` (moved from `cli/src/cdp-shot-a11y.ts:14-54`), `packages/cli/src/cdp-shot-a11y.ts` — import it.
- `packages/testing/src/cdp-e2e-page.ts:48,148` — `accessibilityTree()`: `Accessibility.getFullAXTree`, then `DOM.describeNode` per finding only.
- `packages/testing/src/e2e-page.ts:34` — optional member; goto hook. `packages/testing/src/e2e-driver.ts:102-111` — audit after the body, inside `withFailureContext`. `packages/testing/src/test-types.ts:155` — `TestOptions.a11y`.
- `examples/dummy/apps/**`, `dummy/social-media-clone/apps/**`, framework components in `packages/ui/src/components` and `packages/admin/src` — fix what it finds, through `t()`.
- `wiki/Testing.md`, `wiki/Upgrading.md`, `wiki/Error-Codes.md`, `packages/testing/{README,CLAUDE}.md`.

## Steps
1. `bun run new-error-code X_E2E_A11Y_VIOLATION --package testing --title '…' --cause '…' --fix '…'`.
2. `auditTree(nodes)`: unignored nodes in the table with a blank trimmed name. Keys on `role.value` and `role.type`, so `Iframe` is not confused with an author's string.
3. Rendering: rule, role, bounded 120-character `outerHTML` from `backendDOMNodeId`, URL. Deduped by those four, so a shared header reports once per suite run per URL.
4. In a page mid-navigation `navigatedAway` (`cdp-e2e-page.ts:44`) answers "not this document": retry once, as `waitFor` treats it.
5. Run over both tracked apps; fix each finding. Only if a finding needs its own PR, pin `e2e` in `expectedRed` with the finding named, and remove the pin in the same sweep.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_E2E_A11Y_VIOLATION` | a page in this test has a control, image or heading with no accessible name, no title or `lang`, or focus inside `aria-hidden` | name it: visible text, `aria-label`, `<label for>`, `alt`; `alt=""` for a decorative image. The cause lists each element. Deliberate: `{ a11y: { allow: [{ role, selector, because }] } }` |

## Tests
- `packages/testing/src/e2e-a11y.test.ts` (unit): the probe's tree, recorded as a fixture: every empty row flagged, `alt=""` and `aria-hidden` pruned rows pass, `img` spelled wrongly in the table fails a pin against `image`.
- `packages/testing/src/e2e-a11y.e2e.test.ts` (real browser): a page with one unnamed button fails its test with the code; naming it passes; `allow` without `because` refused; a dialog opened after `goto` is caught at the end of the body.
- `packages/cli/src/cdp-shot-a11y.test.ts`: unchanged through the move.
- `bun test packages/testing/src/e2e-a11y.test.ts`

## Semver
Breaking: a new red verdict in `e2e`. Upgrading: "every `e2eTest` now audits the browser's accessibility tree. Name what it lists, or add `{ a11y: { allow: [{ role, selector, because }] } }` to that test."

## Done when
- A scaffolded app with an unnamed button fails `x verify --only e2e` with no opt-in line anywhere; `scaffold-smoke` green twice per shape.
- Both tracked apps green, `expectedRed` empty; e2e step time stated in the PR.
- `grep -rn 'getFullAXTree' packages --include=*.ts` answers one source file.

## Risks
- Role spellings are the browser's, not a standard's API. The e2e test is the pin: a browser rename goes red on the runner's image, loudly.
- A framework `ui` component failing this surfaces in every app at once; that is why its components are in this slice's file list.
