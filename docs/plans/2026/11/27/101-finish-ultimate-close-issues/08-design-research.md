# 08 — Design research: `x design research` + `x shot --against`

> Part of [`overview.md`](overview.md). Depends on: 06 (motion scale module). Can run beside 07. Tier: 5 (`cli`), 4 (`mcp` type). Issue #1374, part 3.

Rule: one browser path. Research runs on the CDP driver `x shot` already uses
(`packages/cli/src/cdp-shot-driver.ts`); no Playwright in the framework or the scaffold. The command
is the mechanism; the `design-research` skill (09) is the procedure that drives it.

Falsified claim: #1374 says the scaffold "ships Playwright MCP". It does not —
`packages/cli/src/templates/scaffold-mcp-json.ts:17-31` writes one server (the dev MCP); the only
"playwright" strings are ignore rows (`scaffold-repo.ts:361`, `scaffold-container.ts:149`).

## API

| Piece | Shape | Extends |
|---|---|---|
| `x design research <url…> [--follow <n>] [--out .x/design] [--viewport] [--allow-hosts] [--json]` | per URL: `shot-390.png`, `shot-1440.png` (light/dark), `reference.json` (palette clusters by usage, font families + scale, spacing histogram, radii, shadows, `backdrop-filter` use, each `getAnimations()`/transition: duration, easing, delay, trigger enter/hover/scroll), `tokens.proposal.json` (a `defineTheme({ colors, radius, motion })` argument passing its own contrast checks), `motion-map.json` (observed animation → `@ultimat3/ui/motion` call or `@ultimat3/effects` entry), `sources.json` (URL, licence posture applied: `ideas-only` \| `mit-attribution` \| `apache-notice`) | `cdp-shot-driver.ts`, `mcp-ui-inspect.ts`, `mcp-ui-interact.ts`, `shot-viewport.ts`, `cmd-shot-spec.ts` flags |
| `x design research --list` | default reference sources as data (React Bits, 21st.dev, Paper Shaders, shaders.com, reui, shadcn/ui, Motion) with licence posture | `messages-design.ts` |
| `--follow <n>` | visits ≤ n same-origin links — the site is a catalogue | `--allow-hosts` semantics |
| `x shot <route> --against <png \| .x/design/<slug>>` | writes `diff.png` + similarity into `verdict.json`; recorded, never gating | `diffShots` moved from `mcp-ui-diff.ts` to a shared module |
| dev MCP `ui.research` | the same command (axiom 2) | `mcp-ui.ts`; `packages/mcp` `DevCapabilities` type |

Page text from a reference is untrusted data: never written into prompts or files except as measured
values. Third-party pixels stay in `.x/` (gitignored); nothing captured is committed.

## Files to change

- `packages/cli/src/{cmd-design.ts,cmd-design-spec.ts,design-extract.ts,design-map.ts,messages-design.ts}` (new); `registry.ts` entry.
- `packages/cli/src/templates/motion-scale.ts` (from 06) — `design-map.ts` snaps durations/easings with it; palette → nearest role via the theme's contrast tables.
- `packages/cli/src/cmd-shot.ts`, `cmd-shot-spec.ts` — `--against`; `packages/cli/src/shot-diff.ts` (new shared home of `diffShots`); `mcp-ui-diff.ts` imports it.
- `packages/cli/src/mcp-ui.ts`, `packages/mcp/src/dev-agent-tools.ts` — `ui.research`.
- Error codes (`bun run new-error-code … --package cli --off-socket`): `X_DESIGN_URL_REFUSED` (not http(s), private/loopback host — reuse `@ultimat3/scraping`'s outbound host guard if it has one; check first), `X_DESIGN_REFERENCE_UNREACHABLE` (navigation failed/timed out; fix: `--timeout <ms>` or drop the URL), `X_SHOT_AGAINST_MISSING` (fix: `bunx x design research <url>` first).
- `wiki/Design-Research.md` (new), `wiki/CLI-Reference.md` rows.

## Steps

1. Move `diffShots` to `shot-diff.ts`; add `x shot --against`.
2. `design-extract.ts` runs in-page via the CDP driver: computed styles of visible elements, `document.getAnimations()` after a scripted scroll + hover pass, then `design-map.ts` maps to tokens.
3. Command spec + `--json` + error codes; project as `ui.research`.
4. Fixture server test (local HTML with known palette/timings) — never the live web in CI.

## Tests

- `design-map.test.ts` — nearest role/rung; proposal passes `defineTheme`.
- `cmd-design.test.ts` — local fixture server; refusal tests for private hosts; `--follow` cap.
- `cmd-shot-against.test.ts` — identical image ⇒ similarity 1; missing reference ⇒ `X_SHOT_AGAINST_MISSING`.
- Browser tests live in the `e2e` step with existing `shot-browser` discovery/skip semantics (Windows CI has Chrome).
- `bun test ./packages/cli/src/design-map.test.ts`.

## Done when

- `bunx x design research https://reactbits.dev/backgrounds/holo-mosaic --json` writes all five artefacts and a token proposal that `defineTheme` accepts.
- `x shot <route> --against .x/design/<slug>` writes a diff and a similarity figure.
- `ui.research` answers the same over the dev MCP.
- `bun run verify` green.
