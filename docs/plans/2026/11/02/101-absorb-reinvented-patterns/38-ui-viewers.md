# 38-ui-viewers — Reading what agents and machines write

> Part of [`overview.md`](overview.md). Depends on: [`38-ui-lists.md`](38-ui-lists.md) (`VirtualList`). Tier: 4 (`ui`).

## Why
A framework whose primary author is an agent, with `llm()` and `x mcp`, has no way to show what a model wrote, and no code block, diff, log or terminal output. An agent's first answer is `innerHTML` from a parser dependency, which the dependency bar refuses and the CSP and an injection review refuse harder.
| Viewer | Evidence |
|---|---|
| Markdown | 338 LOC and 240 LOC at two adopters; a third's chat app has its own. All independently chose text → tree → elements, never HTML |
| Code block | 90, 113 and more LOC at three adopters; two state the same rule: joined tokens equal the input byte for byte |
| JSON | one adopter's `json-view.ts`, 78 LOC; every webhook, event and tool-call screen wants it |
| Diff | 59 LOC plus a line differ at one adopter; review, audit trails, version history |
| Log | 132, 288 LOC at two adopters; level filter, follow, a hand cap of 2,000 lines |
| Terminal output | one adopter renders styled runs from the server, and refused a browser emulator at about 350 kB against a 120 kB route budget |

## Decisions
| Question | Answer |
|---|---|
| Output | a node tree rendered by JSX. **No `innerHTML` in this slice**, so a body cannot inject markup. Raw HTML in markdown prints as text. A test greps these files |
| Markdown scope | CommonMark's working set an agent writes, plus tables, task lists, strikethrough, autolinks, nested lists. Not full conformance; stated in the docs. Over a size or nesting cap the rest renders as plain text, in linear time, never a thrown page |
| Links | `http`, `https`, `mailto`, relative only; anything else renders as text. External: `Link external` hardening |
| Images | a remote image from model text is a tracking pixel and a CLS hit. Default prints the alt as a link. `resolveImage(src)` returns `{ src, width, height }` or null, and renders `Image` |
| Heading level | `baseLevel` prop: a body must not add a second `h1` |
| Highlighter | small tokenizer per language: `ts`, `json`, `shell`, `sql`, `html`, `yaml`, `diff`. Unknown: plain. Classes only; colours are chart and status roles, so a theme recolours. Runs on the server: 0 B. An island pays per language it passes: `languages` prop, below |
| Which languages load | `CodeBlock` and `Markdown` take `languages?: readonly Language[]`, each language a named export; `allLanguages` for a server page. Absent: plain text. Neither imports a language itself, or a `Markdown` in an island would retain all seven (axiom 6) |
| Adding a language | `defineLanguage()`, an array of rules; a mechanism so nobody forks |
| Second way to render code? | `Markdown` fences call `CodeBlock`. One path |
| Live streaming markdown | re-parse on tick; keyed by block index, so finished blocks keep nodes. An open fence renders as a fence |
| Diff input | `old` and `new` text, or a unified patch; one parser to rows. Myers, line level, plus word marks inside a changed pair. Over `maxLines` folds and says so. Hue is never alone: `+`, `-` gutters, spoken words |
| Diff layout | unified below `md`, side by side at and above, by `@container` |
| Log vs terminal | `LogViewer` is structured rows; `TerminalView` is one styled stream. Both read to `VirtualList` |
| ANSI palette | SGR 30-37, 90-97 map to semantic roles (red `danger`, green `success`, yellow `warning`, blue `info`, cyan and magenta `chart-*`). 256 and truecolor fall to default foreground: no raw colours. Cursor moves ignored; an emulator stays the app's server side |
| Terminal input | none. Output viewer. Keystrokes are an app's island over its own transport |
| Geo, maps | killed: tile data is a dependency and a vendor |
| Rich text editor | killed: a dependency-sized subsystem; `Textarea` plus `Markdown` preview |

## Components
| Component | Base | Keyboard | No script | Mobile | `examples/dummy` |
|---|---|---|---|---|---|
| `Markdown` | elements from a tree | links only | full | tables scroll in their box, 16 px body floor | `posts/[id]/page.tsx` body |
| `CodeBlock` | `<pre><code>`, `CopyButton` | scroll region `tabindex="0"` named | selectable, no copy | sideways in its box, wrap toggle | `posts/[id]/page.tsx`, a fence in the body |
| `JsonView` | nested `<details>` | native | full | wraps long strings | `runs/run-usage.tsx`, raw usage |
| `DiffView` | `<table>`, gutters | scroll region focusable, Next change button | full | unified below `md` | `posts/[id]/page.tsx`, draft against its review (`actions/keep-draft-review.ts`) |
| `LogViewer` | `VirtualList` rows, `<time>` slot | filter field, follow toggle, row links | every line given | single column, timestamp above the line | `runs/run-console.island.tsx` |
| `TerminalView` | `<pre>` of spans via `VirtualList` | focusable region, Home and End | all text | font token, wrap on | `runs/run-view.tsx` |

## Files to change
- `packages/ui/src/content/markdown-parse.ts`, `markdown-inline.ts`, `markdown-tree.ts` (new) — blocks, inlines, the type; `Markdown.tsx`, `.module.scss` in `components/`.
- `packages/ui/src/content/highlight.ts`, `languages/{ts,json,shell,sql,html,yaml,diff}.ts` (new); `components/CodeBlock.tsx`, `.module.scss`.
- `packages/ui/src/components/JsonView.tsx`, `.module.scss`, `json-view-view.ts` (new) — depth cap, stable key order as given.
- `packages/ui/src/content/line-diff.ts`, `unified-patch.ts` (new); `components/DiffView.tsx`, `.module.scss`.
- `packages/ui/src/components/LogViewer.tsx`, `.module.scss`, `log-viewer-view.ts` (new) — level filter, cap, `liveWindow`-style trim.
- `packages/ui/src/content/ansi.ts` (new); `components/TerminalView.tsx`, `.module.scss`.
- `packages/ui/src/index.ts`, `i18n-keys.ts`, `packages/i18n/src/catalogs/en.json` — exports; `ui.code.*`, `ui.diff.*`, `ui.log.*`.
- `packages/ui/src/tokens/_colors.scss` — no new role; token-map test holds this.
- `examples/dummy/apps/web/app/posts/[id]/page.tsx`, `runs/run-view.tsx`, `runs/run-console.island.tsx`, `runs/run-usage.tsx`, `examples/dummy/x.manifest.json`, the app's catalog.
- `scripts/ui-barrel-bytes.test.ts`; `packages/ui/README.md`, `packages/ui/CLAUDE.md`, `packages/ui/CATALOG.md`, `wiki/Interface-Rules.md`, `wiki/UI-Components.md`, the wiki's AI page (rendering a model's text: `Markdown`).

## Steps
1. `highlight.ts` first: property: joined tokens equal input, for each language, on hostile text.
2. Markdown parser. Every construct linear; caps on nesting and length. `Markdown({ text, baseLevel?, resolveImage?, languages?, class })`.
3. `CodeBlock`, then fences in `Markdown`. Then `JsonView`.
4. `line-diff.ts`, `DiffView`. Diff over `maxLines` stops and folds; no quadratic blow-up on hostile input.
5. `ansi.ts`: split runs, unknown escapes dropped, never printed. `TerminalView`, `LogViewer` on `VirtualList`.
6. Measure each: server page 0 B. Island `Markdown`, `CodeBlock` with one language, `LogViewer` stated in the diff (`bun run budget-raises`). Barrel-shake pinned so an unused viewer or language retains nothing. `Markdown` is the one renderer of markdown: [`42-adopt-docs-site.md`](42-adopt-docs-site.md) builds on it.

Motion: none. `follow` scroll obeys the reduced-motion rule in `38-ui-lists.md`.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_UI_INVALID_VALUE` (existing) | `defineLanguage` with a rule whose regex can match empty; a malformed `resolveImage` result | cause names the rule. Malformed **content** is never an error: a body from a model prints as text |

## Tests
- Unit: `markdown-parse.test.ts` (`<script>` is six characters of text; `javascript:` link is text; 100 KB of `*` and `[` under a time ceiling; nested caps), `highlight.test.ts` (byte-for-byte property), `line-diff.test.ts`, `unified-patch.test.ts`, `ansi.test.ts` (no escape byte in output; 256-colour gets no raw colour), `log-viewer-view.test.ts`, `json-view-view.test.ts`.
- `packages/ui/src/components/viewers-no-html.test.ts`: source of every viewer has no `innerHTML`, `outerHTML` or `insertAdjacentHTML`. `source-text.test.ts` is the pattern.
- `packages/cli/e2e/ui-viewers.e2e.test.ts` (browser): a hostile body raises no `alert` under CSP; a wide table leaves `scrollWidth <= innerWidth` at 390 px; follow holds at the end, releases on scroll up; `dir="rtl"`: code stays LTR. Command `bun test packages/ui/src/content/markdown-parse.test.ts`.
- `scripts/ui-barrel-bytes.test.ts`: `Button` retains nothing from `content/`; `Markdown` with no `languages` retains no `languages/*`; one passed retains one.
- `packages/ui/src/tokens/contrast.test.ts`: token classes on the code surface reach AA, every preset.

## Semver
breaking; lands in v30.
**Breaking, one row.** `UI_KEYS` gains keys. Upgrading: "Add `ui.code.*`, `ui.diff.*`, `ui.log.*` to any `Record<UiKey, string>`." The rest is additive.

## Done when
- A post body with `<script>`, `javascript:` and a remote image renders inert, with no reflow, on a static route at 0 B of script.
- A 100,000-line run log scrolls on a phone with under 100 rows mounted and follows the end.
- A diff is readable with colour off.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green.
