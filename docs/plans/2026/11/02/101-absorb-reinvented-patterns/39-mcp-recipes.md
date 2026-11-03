# 39 — MCP recipes that cannot go stale

> Part of [`overview.md`](overview.md). Depends on: [`09-core-define-error.md`](09-core-define-error.md) (for declared `docs`). Tier: 4 (`mcp`), 5 (`cli`).

## Why
Agents stuck mid-task need "how do I do X here". Two adopters wrote 428 and 915 LOC for it. `core/src/errors.ts:38` documents `docs://recipes/refund-a-payment` and `mcp/src/framework-error.ts:29` prints it, yet nothing in the framework serves that URI: the documented example resolves only if an app hand-writes the resource (`mcp/src/resources.ts:21`). A renamed tool leaves every recipe naming a tool that no longer exists, and the agent follows it.
Recorded objection: four codes for optional text. Answer: a recipe here is not text. Each step names a tool and an example checked against that tool's input schema at load, so the stale recipe is a boot failure.

## Decisions
| Question | Answer |
|---|---|
| Shape | `recipes: [{ name, title, description, steps: [{ tool, why, example? }], notes? }]` on `defineAppMcp` (`app-tools.ts:61`) |
| Second way beside `resources:`? | no. A recipe becomes an `McpResource`. `resources:` refuses a `docs://recipes/` URI, so one spelling owns the prefix |
| Free text in `notes` | allowed and unchecked; a step is where a tool is named |
| A tool hidden from this caller | the recipe is hidden too: visible only when every step's tool resolves for the caller (`visibleToCaller`, scope gate, as `ResourceResolution`). A staff workflow stays off a customer's list |
| Clients that ignore resources | many do (`app-tools.ts:113` notes a sibling). With recipes present a read-only `docs({ name? })` tool lists or reads them, stays flat on a `'meta'` surface, and collides with an app's own `docs` through `assertUniqueNames` |
| `UltimateError.docs` | a `docs://recipes/<name>` from `defineError` is checked at load across every endpoint in `ai.mcp` (`cli/src/app-mcp.ts`). One built at a throw site is checked at render: in test and dev it raises, in production the line is dropped and logged, so an agent is never sent nowhere |
| Rendering | markdown, deterministic, from the structure. No template language |

## Files to change
- `packages/mcp/src/recipes.ts` (new) — types, load check, render, `recipeResources()`.
- `packages/mcp/src/recipes-tool.ts` (new) — the `docs` tool.
- `packages/mcp/src/app-tools.ts:61,246` — the option, merged after `withScopes` so a check sees the final catalog, including `X_MCP_SCOPE_UNCOVERED`'s exemption for `docs` beside `whoami`.
- `packages/mcp/src/resources.ts:112` — reserved prefix; `framework-error.ts:60` — render check. `packages/mcp/src/errors.ts`.
- `packages/core/src/define-error.ts` (from 09) — declared `docs` readable by code.
- `packages/cli/src/app-mcp.ts:86-124` — load check over the union of endpoints.
- `examples/dummy/packages/mcp/` — one recipe, and one error pointing at it. `wiki/MCP-And-AI.md:196-203`, `wiki/Error-Codes.md`, `packages/mcp/{README,CLAUDE}.md`, `packages/core/CLAUDE.md`.

## Steps
1. `bun run new-error-code` for each code.
2. At `defineAppMcp`: unique `name` matching `[a-z0-9-]+`; every `step.tool` in the projected catalog; every `step.example` parsed by that tool's input (`validateAsync`, issues only in the error, as `formatIssues`). All offenders collected, as `toolsListed` does, so one boot reports all.
3. URI `docs://recipes/<name>`, `mimeType: 'text/markdown'`, `read()` renders on demand.
4. `resources/list` and `resources/read`: hidden and unknown answer the same not-found, as a tool's cut does.
5. `docs({})` answers name, title, description for visible recipes; `docs({ name })` the body. Annotated read-only; no rate-limit class of its own.

## Error codes
All `--off-socket`: raised at boot or in tests.
| Code | When | Fix |
|---|---|---|
| `X_MCP_RECIPE_TOOL_UNKNOWN` | a step names a tool not in the catalog | rename `step.tool` in recipe `<name>`, or expose the tool; the cause lists the catalog |
| `X_MCP_RECIPE_EXAMPLE_INVALID` | an example fails the tool's input | correct `step.example`; the issues name the field |
| `X_MCP_RECIPE_UNKNOWN` | an error's `docs://recipes/<name>` names no recipe | add it to `recipes:`, or drop `docs:` |
| `X_MCP_RECIPE_URI_RESERVED` | `resources:` holds a `docs://recipes/` URI, or two recipes share a name | move it to `recipes:` |

## Tests
- `packages/mcp/src/recipes.test.ts` (unit): rename a tool, boot refuses with both recipe and tool named; a stale example refused; collected offenders; deterministic body.
- `packages/mcp/src/recipes-visibility.test.ts` (unit): a caller without one step's scope gets not-found on list, read and `docs`, byte-equal to an unknown name.
- `packages/mcp/src/error-audience.test.ts:132`: the existing `docs://recipes/issue-a-credit-note` case now needs that recipe, and an unresolved URI raises under test.
- `packages/cli/src/app-mcp.test.ts`: two endpoints, a recipe on either satisfies an error's link.
- `examples/dummy`: reading the recipe over `mcp-drive.contract.test.ts`. `bun test packages/mcp/src/recipes.test.ts`

## Semver
Minor. Option absent changes nothing. A hand-written `docs://recipes/` resource is refused only once `recipes:` exists on that server; the reserved-prefix refusal for one with no `recipes:` waits for the next major, with an Upgrading row: "move it to `recipes:`". A throw-site link stays unjudged on a server with no `recipes:`.

## Done when
- A tool rename in `examples/dummy` with a stale recipe fails `x verify`.
- The URI printed by `UltimateError.docs` resolves over `resources/read` and over `docs`.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green.
