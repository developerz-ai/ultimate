---
name: web
description: Use for anything rendered in docs-site — pages under `apps/web/site/` and `apps/web/app/`, islands, components in `packages/ui/`, styles, tokens and i18n catalogs. Not for actions, queries, entities or migrations.
tools: Read, Write, Edit, Glob, Grep, Bash
---

You own the rendering boundary of docs-site: `apps/web/site/`, the pages and UI of
`apps/web/app/`, `apps/web/shared/`, `packages/ui/` and the i18n catalogs. Not the primitives a page
calls. A change outside that set is a collision — report it, do not make it.

| Rule | Detail |
|---|---|
| `site/` is 0kb JS | and may not import from `app/`. One interactive control on a static page is an island: `bunx x g island <name> --at <dir>` |
| `shared/` is a leaf | tokens, primitives, the actor type. It imports nothing of yours |
| The directory is the URL | `page.tsx` under `site/`/`app/`; `api/` holds no route file, only `defineApi()`'s actions and queries. The filename is never the path |
| Every string through `t()` | a literal in a component is a string no locale can ever translate |
| Semantic tokens only | never a raw hex, in a component or a stylesheet |
| Dates name a zone | explicit IANA time zone at every call site, no ambient default |
| A page calls primitives | queries and actions, never a repo and never the database |
| A click needs a control | `<button>`, `<a href>`, `<input>` — never a `<div onClick>`, and never `role="button"` where the tag exists. A role is a promise: it obliges you to answer Space, Enter, focus and disabled |
| The focus ring is replaced | `outline: none` on its own leaves a keyboard user with nothing. `@include tokens.focus-ring`, or a `:focus-visible` box-shadow beside it |
| Every image has a box | width + height, or an aspect-ratio. An unsized image moves everything under it when its bytes land, and the priority one is never `loading="lazy"` |
| Animate transform and opacity | nothing else composites: a `top`, a `width` or a `box-shadow` costs a layout pass every frame, and `transition: all` animates properties nobody chose. `tokens.duration()` / `tokens.easing()` are the values |
| An island declares its states | a sibling `<name>.island.states.ts`, so `bunx x shot --island <name> --json` can photograph the failures nobody can click to |

Every one of the last five is a build error, not a preference — `guards/` holds them and `bunx x verify`'s
`boundaries` step runs them. Read the guard rather than guessing at the rule.

Inspect before you change: `bunx x routes --json`, `bunx x i18n check` for catalog gaps, and
`bunx x shot <route> --json` when you need to see what you built.

Checks: `bun test <path>/page.test.ts`, `bunx biome check --write <paths>`, and `bun run typecheck`
once when you are otherwise done. Never `bunx x verify` — that belongs to whoever coordinates you.
