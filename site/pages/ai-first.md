---
title: AI-first
menu: true
nav: AI-first
description: An MCP dev server, every action exposed as a tool with identical authz, generated facts instead of generated prose, and --json on everything.
lede: Not a chat widget. The framework is built so an agent can read it, drive it, and verify its own work — and so the apps it generates have the same property.
updated: 2026-07-26
---

## Built-in MCP dev server

`x dev` starts an MCP server on the dev socket. Point Claude Code or any MCP client at it and
the agent stops guessing.

| Tool | Introspects / does | Replaces the agent's usual guess |
|---|---|---|
| `routes.list` | route table: path, render mode, hydrate, offline, budget, meta status | grepping a router directory |
| `schema.describe` | tables, columns, types, indexes, FKs, invariants | reading migration files in order |
| `policies.list` | every `policy`, which actions/queries use it, its denial reason | "is this endpoint protected?" |
| `actions.list` | inputs, outputs, tags, MCP exposure | reading `api/` by hand |
| `manifest.get` | the whole `x.manifest.json` | ten separate reads |
| `tests.run` | run a test type or a single file, structured results | parsing terminal output |
| `logs.tail` | structured logs + OTel spans, filterable | scrollback archaeology |
| `db.query` | **read-only** SQL, 1000-row cap, `EXPLAIN` on request | inventing a query and hoping |
| `db.migrate` | generate + apply migrations **in a branch DB only** | mutating the dev database |
| `errors.explain` | `X_*` code → cause, fix command, docs URL | web search |
| `budgets.report` | per-route bytes/LCP with the import chain that caused a regression | bisecting bundles |

Read tools are unrestricted in dev. Write tools are scoped to branch environments. The dev
server is never exposed in `ROLE=web`.

## Every action is an MCP tool

```ts
mcp: { expose: true, description: 'Publish a draft post' },
```

That line is the entire integration.

| MCP requirement | Source |
|---|---|
| tool name | action name |
| JSON Schema for input | the ArkType `input` (Standard Schema → JSON Schema) |
| output schema | `output` |
| description | `mcp.description` |
| **authorization** | the action's `policy` — unchanged, unwrapped, identical |
| audit trail | the same OTel span and log line as an HTTP call |

Authz for free means authz *identical*. There is no MCP-specific permission table, no "trusted
tool" mode, no service account with broad rights. Two authz systems is how every Meteor-like
framework died.

## The apps you build are AI-first too

```text
packages/mcp/          # the app's own MCP tools
apps/admin/            # generated admin dashboard — exposes MCP over the app's actions
```

| Property | Consequence |
|---|---|
| Actor = the signed-in user's session | an agent can never exceed the human it acts for |
| Policies unchanged | no separate "API permissions" screen to get wrong |
| Admin dashboard ships with MCP on | day-one agent access to operations, not a v3 roadmap item |
| Tool list is generated | adding a feature adds a capability; deleting one removes it |

Competing frameworks make "add an AI feature" a project. Here it is the default state of the
code you already wrote.

## Generated facts, hand-written conventions

| Artifact | Author | Contents | Rule |
|---|---|---|---|
| `x.manifest.json` | **generated**, every build | routes, entities, actions, mutators, queries, jobs, tasks, policies, cache tags, MCP tools, budgets, build ID | never hand-edited; drift is a `x verify` failure |
| `openapi.json` | **generated** | HTTP surface from action/query declarations | contract diff in `x verify` |
| `AGENTS.md` | **human-authored**, short | project-specific conventions an agent cannot infer | never generated, never auto-appended |
| `CLAUDE.md` | **human-authored**, short | same, compressed-config style |

LLM-generated context files measurably reduce task success: a model writing "here is what this
codebase does" produces confident, plausible, partly-wrong prose that the next agent treats as
ground truth. So facts come from code — structured, verifiable, regenerated every build — and
conventions come from a human. Ultimate never generates prose documentation at runtime.

## LLM gateway primitive

```ts
export const summarize = llm({
  model: 'claude-sonnet-4-5',
  input:  t.object({ postId: t.uuid }),
  output: t.object({ summary: t.string, tags: t.string.array() }),
  prompt: summarizePrompt,                       // versioned artifact
  cache:  { semantic: { threshold: 0.97, ttl: '7d' } },
  budget: { tokensIn: 8000, costPerCall: { minor: 5, currency: 'USD' } },
  policy: can('post:read'),
});
```

| Feature | Behavior |
|---|---|
| Structured output | `output` drives tool-use/JSON mode; a parse failure retries once, then throws `X_LLM_OUTPUT_INVALID` |
| Streaming | first-class, wired to Solid signals and `stream` routes |
| Cost + token accounting | per call, per tenant, per prompt version; exceeding `budget` throws before spending |
| Retries | typed on provider errors; rate limits back off, content refusals do not retry |
| Caching | semantic cache keyed by embedding + model + prompt version, tenant-scoped |
| Tracing | one OTel span per call with model, tokens, cache hit, prompt version |
| Fallback | ordered model list; a fallback is recorded in the span, never silent |
| Money | `Money = { minor, currency }` — never a float |

Prompts are versioned files with typed slots, not string literals, and **every prompt has an
evals file — no evals is a `x verify` failure**. `eval` is one of the six test types.

## Branch environments

```text
x branch feat-new-billing
  ✓ database    myapp_feat_new_billing   (copy-on-write from dev template)
  ✓ build       build id 8f2a1c…
  ✓ preview     http://feat-new-billing.localhost:3000
  ✓ mcp         ws://localhost:9229/feat-new-billing
```

An agent can migrate, seed, test and browse a preview without risking anything shared. The
branch build ID scopes the service-worker cache, so a preview can never poison prod caches.

## `--json` everywhere

```text
$ x verify --json
{"ok":false,"checks":[{"name":"budgets","ok":false,"failures":[
  {"route":"site/pricing","metric":"js","actual":"61kb","limit":"40kb",
   "cause":"chart.js via shared/ui/button.tsx",
   "fix":"x fix boundary site/pricing/page.tsx"}]}]}
```

| Surface | Machine form |
|---|---|
| CLI | `--json` on every subcommand |
| Errors | `UltimateError` serializes to `{ code, cause, fix, docs }` |
| HTTP errors | same JSON body, same codes |
| Dev overlay | the identical string a terminal shows |
| MCP | tool errors carry the same code + fix |

An agent that can parse the failure and read the fix command closes the loop without a human.
That is the whole thesis, made operational.
