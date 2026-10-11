# Agents

`agent()` is an **action factory**, not a ninth primitive. A tool-using run is one server-authoritative operation with an input schema, an output schema and a policy — the definition of an `action` — so `agent()` returns one, and inherits `.openapi()`, `.client()`, `.job()`, `.contract()`, its MCP tool (`toolFrom`) and its manifest row without a line of agent-specific code.

`As of 2026-08`. Source: [`packages/ai/src/agent.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/ai/src/agent.ts). The gateway, prompts, evals and the MCP surface are [MCP and AI](MCP-And-AI); the primitive vocabulary is [The eight primitives](The-Eight-Primitives).

## Register your models, pick your provider

**The app names every model an agent runs on, and the provider that serves it.** `As of 2026-10`. The framework ships the mechanism — the `Provider` contract, two wire-format adapters as peers, the gateway, budgets, `registerModel` — and no vendor choice. Full reference: [`packages/ai/README.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/ai/README.md).

```ts
// app.config.ts, or any module the boot imports
import { configureAi, providerGateway, openAiProvider, registerModel } from '@ultimat3/ai';

registerModel({
  id: 'house-large',
  contextWindow: 200_000,
  maxOutput: 32_000,
  inputPerMillion: { minor: 300, currency: 'USD' },
  outputPerMillion: { minor: 1_500, currency: 'USD' },
  cacheMinimumTokens: 1_024,
  reasoning: { effort: true, adaptive: false, disableThinkingUpTo: undefined },
});

configureAi({
  gateway: providerGateway({
    providers: [
      openAiProvider({
        apiKey: Bun.env['LLM_TOKEN'] ?? '',
        baseUrl: Bun.env['LLM_URL'] ?? 'http://127.0.0.1:8000/v1',
        models: ['house-large'],
      }),
    ],
    defaultModel: 'house-large',
  }),
});
```

| Provider | Speaks |
|---|---|
| `anthropicProvider({ models, apiKey?, baseUrl? })` | the Anthropic Messages format |
| `openAiProvider({ baseUrl, models, apiKey, auth? })` | the OpenAI chat-completions format, on any compatible server |
| your own `Provider` | anything — `{ name, models, generate, stream }` |

An agent's model resolves from, first match wins: its `model`, its prompt's `model`, then `providerGateway({ defaultModel })` (`resolveModel`, `packages/ai/src/model-resolve.ts`). The gateway routes it to the first provider whose `models` lists it.

The framework ships no default model and no catalogue row (25.0.0): every id is one the app `registerModel`-ed.

| Missing | Refusal | Fix |
|---|---|---|
| none of the three names a model | `X_AI_MODEL_UNRESOLVED`, naming all three | `model:` on the declaration or in `definePrompt`, or `providerGateway({ defaultModel })` |
| the id was never registered | `X_AI_MODEL_UNKNOWN`, before any provider call or budget reservation | `registerModel({ id, … })` at boot, in the app's `models.ts` |

## Two per-model rows worth knowing

| Row | When |
|---|---|
| `sampling: { temperature: true, seed: true }` | the model accepts `temperature` / `seed`. Absent, a declaration's `temperature` and `seed` are not sent to it |
| `forcedToolChoice: false` | the model rejects a **forced** tool choice. `llm()` offers exactly one tool (`respond`) and the chat-completions wire names it in `tool_choice`; a model whose thinking is always on answers that with a 400 — measured 2026-10-11 through OpenRouter on `anthropic/claude-sonnet-5.5`: `tool_choice: type "tool" and "any" are not supported for this model`. With the row, the tool is offered under the endpoint's default and a prose answer takes the repair turn. `agent()` never forces a choice and is unaffected |

## Quick answers

| Question | Answer |
|---|---|
| How do I make one agent call another agent? | List it in the caller's `tools`. An agent **is** an action, so it needs nothing else → [An agent is a tool of another agent](#an-agent-is-a-tool-of-another-agent) |
| How do I cancel an agent run when the user closes the tab? | `ctx.signal`. Over HTTP that signal is the **request deadline**, not the socket — a closed tab does not abort it `As of 2026-08` → [Cancellation](#cancellation) |
| How do I run an agent over 2 million rows without blowing my budget? | `backfill()` for the sweep, `hive()` or `agentJob()` per page, `budget.tokensPerRun` on both, and a shared `BudgetStore` for the fleet-wide ceiling → [Millions of rows](#millions-of-rows) |
| Do agent tool calls run in parallel? | Yes — every tool of **one turn**, concurrently and unbounded. Turns themselves are serial → [Tools of one turn run concurrently](#tools-of-one-turn-run-concurrently) |
| How do I stop paying full price for the same long prompt every turn? | Nothing — `agent()` asks the provider to cache each turn's prefix by default. Put text every run shares in `system().stable` → [Provider prompt caching](#provider-prompt-caching) |
| What stops an agent that loops, or hangs, with nobody watching? | `maxRepeatedToolCalls` (default 3) and `deadlineMs` → [Unattended runs](#unattended-runs) |
| How do I show progress while an agent is thinking? | `onTurn`, called once per completed turn. There is **no `.stream()`** on an agent → [Progress](#progress-onturn) |

## A worked example

```ts
import { action, t } from '@ultimat3/action';
import { agent, definePrompt } from '@ultimat3/ai';
import { can } from '@ultimat3/policy';

const lookupOrder = action({
  input: t.object({ orderId: t.string }),
  output: t.object({ status: t.string, totalMinor: t.number.int() }),
  policy: can('order:read'),
  mcp: { expose: true, description: 'Read one order by id.' },
  handle: ({ input }) => ({ status: `shipped ${input.orderId}`, totalMinor: 1999 }),
});

const issueRefund = action({
  input: t.object({ orderId: t.string, amountMinor: t.number.int() }),
  output: t.object({ refundId: t.string }),
  policy: can('order:refund'),
  mcp: { expose: true, description: 'Refund an order. Idempotent on (orderId, amountMinor).' },
  handle: ({ input }) => ({ refundId: `rf_${input.orderId}` }),
});

const supportPrompt = definePrompt<{ orderId: string }>({
  id: 'support',
  version: '1.0.0',
  system: 'You resolve support tickets. Answer only through the respond tool.',
  template: 'Resolve the ticket for order {{orderId}}.',
});

export const supportAgent = agent({
  model: 'house-large', // registered above
  input: t.object({ orderId: t.string }),
  output: t.object({ answer: t.string, refunded: t.boolean }),
  prompt: supportPrompt,
  vars: ({ input }) => ({ orderId: input.orderId }),
  tools: [lookupOrder, issueRefund],
  maxTurns: 6,
  maxToolResultChars: 4_000,
  budget: { tokensPerRun: 200_000, costPerCall: { minor: 50, currency: 'USD' } },
  policy: can('order:support'),
  mcp: { expose: true, description: 'Resolve one support ticket end to end.' },
  onTurn: ({ turn, maxTurns, toolCalls, cost }) => {
    console.log(`turn ${turn}/${maxTurns}: ${toolCalls.join(', ')} — ${cost.minor} ${cost.currency}`);
  },
});
```

`supportAgent` is an `Action<TInput, TOutput>`. Call it, project it, queue it, expose it — the six artifacts an action projects are all there, and none of them knows an agent produced them.

## Every field

| Field | Required | Default | Behaviour |
|---|---|---|---|
| `input` | yes | — | parsed before the loop starts; the action's own `input:` |
| `output` | yes | — | projected into the forced `respond` tool, and validated on the answer |
| `prompt` | yes | — | a `definePrompt()` artifact — versioned, content-hashed, evaluated |
| `vars` | yes | — | the one declared place a run loads data, and the one place a redactor sees it. A `Secret` here is `X_AI_PROMPT_SECRET` |
| `tools` | yes | — | real `action()`s. Each must be `mcp: { expose: true }` |
| `policy` | yes | — | the action's own policy, evaluated on every surface identically |
| `model` | no | the prompt's `model`, else the gateway's `defaultModel`; none is `X_AI_MODEL_UNRESOLVED` | a model id the app registered — [Register your models](#register-your-models-pick-your-provider) |
| `maxTurns` | no | **8** | reaching it is `X_AGENT_MAX_TURNS`, never a partial answer |
| `maxTokens` | no | **4,096** | completion ceiling **per turn**. The model never sees it |
| `maxToolResultChars` | no | **4,000** | one tool result's ceiling; truncation says so in the transcript |
| `maxRepeatedToolCalls` | no | **3** | consecutive turns that may repeat the same calls **and** results; reaching it is `X_AGENT_TOOL_LOOP` → [Unattended runs](#unattended-runs) |
| `deadlineMs` | no | none | wall-clock ceiling for the whole run; passing it is `X_AGENT_DEADLINE` |
| `temperature`, `seed` | no | not sent | determinism knobs for a verifier or a classifier (`temperature` 0 to 2, `seed` a whole number). **Sent only to a model whose row takes them** — `registerModel({ …, sampling: { temperature: true, seed: true } })`; to any other they are left out, because a reasoning model answers a sampling parameter with a 400, and the `llm.sampling.ignored` span attribute names what was left out. `seed` exists on the chat-completions wire only (the Messages API has none) and is best effort where it exists; `temperature: 0` narrows variation, it does not promise identical answers. Same two keys on `llm()` |
| `system` | no | — | system text loaded at run time, as `{ stable?, run? }` → [Provider prompt caching](#provider-prompt-caching) |
| `promptCache` | no | **`'auto'`** | `'auto'` \| `'off'` \| `{ session }` — asks the provider to cache each turn's prefix |
| `budget` | no | unmetered | `tokensIn`, `costPerCall`, `tokensPerRun` |
| `mcp` | no | not exposed | exposes the agent itself as a tool |
| `onTurn` | no | — | one call per completed turn, awaited |

## Tools are real actions

`tools: [lookupOrder, issueRefund]` — the imports themselves, not adapters. `agent()` accepts `AnyAction | ProjectableAction`; the real `action()` comes first because it is what an app has.

| Rule | Why |
|---|---|
| A tool must declare `mcp: { expose: true }` | `isMcpExposed` is the one predicate, so an in-app agent and an external MCP client are offered exactly the same catalogue |
| A tool that is not exposed is `X_AGENT_TOOL_UNEXPOSED` **at declaration**, never filtered at the call | a silently dropped tool reads as offered and is not — the worst of both |
| The tool's name is its **export name, verbatim** | the same name `tools/call`, `scopes:` and `openapi.json` use. No second spelling |
| The tool's own `policy` decides every call | there is no "LLM permissions" concept, because there is no second authz system |
| The tool's own `input:` parses what the model sent | which is what drops an `{ actor: 'admin' }` the model invented, before any handler sees it |
| A tool failure is a `tool_result` flagged `is_error`, not a crash | a policy denial is an outcome the model should read and react to |
| A 5xx failure's cause reaches the model only when its code declares it public | the provider keeps every request it is sent; a `X_DB_STATEMENT_FAILED` reads as the code and a fixed sentence — the verdict a production problem document and an MCP client get |
| An **in-process** tool's own typed refusal reaches the model whole | a tool marked `inProcess: true` is the app's code called by its own agent. An `UltimateError` it throws under a code nobody gave an HTTP status is rendered as `{"error":{"code","cause","fix"}}` (the `callerFix` when it has one) — the model needs exactly that to correct its call. Still withheld: an uncoded throw, a framework 5xx, a code the app registered ≥ 500, a look-alike object; never a stack. `discloseErrors: false` opts out |
| The actor is **`ctx.actor`**, read once, and nothing the model emits can reach it | this is the mistake a hand-rolled loop ships, and the reason the loop belongs in the framework |

An unknown tool name answers `unknown tool: <name>` as an error result rather than throwing — the model asked for something it was not offered, which is a turn to correct, not a run to abort.

## An agent is a tool of another agent

An `agent()` returns an action, and a tool is an action. So a supervisor lists a sub-agent in its own `tools` and nothing else is needed — no supervisor primitive, no delegation API.

```ts
import { t } from '@ultimat3/action';
import { agent, definePrompt } from '@ultimat3/ai';
import { can } from '@ultimat3/policy';
import { supportAgent } from './support';

const supervisorPrompt = definePrompt<{ ticketIds: string }>({
  id: 'supervisor',
  version: '1.0.0',
  template: 'Triage these tickets, delegating each to supportAgent: {{ticketIds}}.',
});

export const supervisor = agent({
  input: t.object({ ticketIds: t.array(t.string) }),
  output: t.object({ handled: t.number.int() }),
  prompt: supervisorPrompt,
  vars: ({ input }) => ({ ticketIds: input.ticketIds.join(', ') }),
  tools: [supportAgent],
  maxTurns: 12,
  policy: can('order:support'),
});
```

The sub-agent runs under the **same actor** and through its **own policy**, exactly as any other tool does. It needs `mcp: { expose: true }` like any other tool. Its `budget` derives from the supervisor's, tightening and never widening — see [Budgets](#budgets-and-the-ceiling-that-holds-under-concurrency).

For a fan-out that is a *fixed* list rather than a model's choice, use [`hive()`](#hive--many-members-one-action) instead: the split is declared, not emitted by a model.

## Structured output is the `respond` tool

There is no JSON mode and no `response_format`. `output` is projected into one tool named `respond`, offered alongside the app's tools, and the answer is read out of that tool call.

| Step | Behaviour |
|---|---|
| The model calls app tools | their results go back as `tool_result` blocks and the loop takes another turn |
| The model calls `respond` | its arguments are validated against `output` |
| Validation fails | the failure is fed back as a message naming the issues, and the loop takes **another turn** — unlike `llm()`, which gets exactly one repair |
| Every turn used, and the last failure was a shape | `X_LLM_OUTPUT_INVALID`, naming the attempts and the issues |
| Every turn used, and the loop kept calling tools | `X_AGENT_MAX_TURNS`, naming the turns and the tool-call count |
| Any turn stops at its `maxTokens` (or the context window) | `X_LLM_TRUNCATED`, before a tool runs and before the answer is validated: a cut-off `respond` call reads as `{}`, which an `output` of optional keys would accept |
| The provider refused | `X_LLM_REFUSED`, carrying `stopDetails.category` and naming a more capable model |

Two exhaustions, two codes, on purpose: a loop that kept calling tools and never answered is not the same event as one that answered the wrong shape every time.

`tool_choice` is never forced on an agent. Forcing it would decide the model's next step for it, which is the one decision a tool loop exists to leave open.

## Tools of one turn run concurrently

Every tool a single turn asked for runs **at once**, through one `Promise.all`, and deliberately unbounded.

| Property | Detail |
|---|---|
| Concurrency | the whole batch, in parallel. A turn asking for five tools costs one tool's wall clock, not five |
| No second ceiling here | the batch is bounded by what one turn asked for, and each entry is an action carrying its own `policy` and its own `rateLimit`; a ceiling here would be a throttle competing with those |
| Ordering | **positional**, never by completion. `Promise.all` resolves by index and each result carries the `tool_use` id it was handed, so a fast tool answering first cannot be paired with a slow tool's call |
| Turns | serial, always. Every turn re-sends the whole transcript, which is why cost grows quadratically in turns and `maxTurns` defaults low |
| Budget under parallelism | still holds — every reservation debits before it checks, so concurrent calls cannot all read the same `spent` |

## Budgets, and the ceiling that holds under concurrency

```ts
budget: {
  tokensIn:     8_000,                              // prompt tokens, per call
  tokensPerRun: 200_000,                            // every turn of this run, counted
  costPerCall:  { minor: 50, currency: 'USD' },     // worst-case price of one call
}
```

| Scope | Counts | Declared on |
|---|---|---|
| `tokensIn` | prompt tokens of one call | `agent()`, `llm()`, `hive()` |
| `tokensPerRun` | prompt + completion across **every turn and every nested call** of one run | `agent()`, `hive()` |
| `costPerCall` | worst-case price of one call, integer minor units | `agent()`, `llm()`, `hive()` |
| `actor` / `org` | tokens across a whole window, per identity — the CALLER's: `llm()`, `agent()` and `hive()` key it `budgetKeysFor(ctx.actor)` | `providerGateway({ budget })` |

A budget **refuses**; it never truncates. A shortened prompt yields a confidently wrong answer with no signal, and `X_AI_BUDGET_EXCEEDED` names the scope and what remains.

**Why the ceiling holds when members run in parallel.** Two mechanisms, both in [`packages/ai/src/budget.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/ai/src/budget.ts):

| Mechanism | What it fixes |
|---|---|
| `reserve()` **debits, then checks** — never a read-then-write across an `await` | the in-memory `request` counters are checked and debited with nothing awaited between; the store's `actor` / `org` counters go through `BudgetStore.take(key, tokens, limit)`, one atomic step. A read-then-write let concurrent calls — one request per scope racing one org key — all read `spent() === 0` and all pass. A refusal at a later scope gives back what the earlier ones took; `record()` replaces the estimate with the provider's real counts, `release()` gives it back when the call never happened |
| `derive()` takes the **tighter** of each limit and never the looser | a per-call budget on an inner `agent()` must not be able to widen the actor or org ceiling it runs inside |
| `reserveNow()` walks the **whole** parent chain | each ledger keeps its own counter, and the tightest limit is not always the one with the most spent against it |

`take` is required of every `BudgetStore`, and a store shared across **processes** must make it atomic on its own side — a Redis `EVAL`, a SQL `update … where spent + $n <= $limit`. The default `memoryBudgetStore()` is per process and resets on every deploy: `org: 20_000_000` at six replicas is six ledgers of twenty million.

## Cancellation

`ctx.signal` is the one cancellation seam, and `agent()` reads it in three places: at the top of every turn, before every tool batch, and on the `GenerateRequest` itself — so a provider call already in flight is cut rather than paid for. An aborted run throws `X_ABORTED`.

That matters because the transcript **is** the request: a loop that keeps going after the caller is gone re-sends the whole transcript once per remaining turn, runs every remaining tool's side effects, and discards the answer.

**Where the signal comes from, `As of 2026-08`:**

| Surface | `ctx.signal` fires when |
|---|---|
| HTTP | the **request deadline** passes, **or the caller goes away** — the two are joined with `AbortSignal.any` ([`packages/http/src/deadline.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/http/src/deadline.ts)). The deadline is `requestTimeoutMs` (30s), or the shorter budget the caller sent as `x-request-timeout-ms` |
| Job / `agentJob()` | the attempt times out, or the job is cancelled — `x jobs cancel <id> --reason "…"`. The worker's own `ctx` is what `agentJob` forwards, so the abort reaches the turn loop |
| Your own code | a signal you pass: `withChildContext({ signal }, () => supportAgent(input, { ctx }))` |

**A closed browser tab DOES abort an in-flight agent, `As of 2026-08`.** `pipeline.ts` hands the inbound `Request.signal` to `startDeadline`, which joins it with the timer's controller through `AbortSignal.any` — so a disconnect unwinds the turn loop instead of paying for every remaining turn. This page said the opposite until 12.0.0, and it was true when it was written: nothing in `@ultimat3/http` read the inbound signal, so a closed tab held its handler, its pool slot and its vendor connection for the whole budget.

| Want | Do |
|---|---|
| every agent request bounded | call `configureHttp({ requestTimeoutMs: 120_000 })` at module scope in a file under `apps/*/` — `ctx.signal` fires there and `X_TIMEOUT` answers the socket either way |
| this call bounded shorter | send `x-request-timeout-ms` with the milliseconds you will wait; a caller may only **shorten** the deadline, never lengthen it, and anything under 1ms falls back to the server's own budget |
| the next hop bounded by what is LEFT | nothing — both typed clients spread `traceHeaders()` before your own headers, and it sends the **remaining** budget as `x-request-timeout-ms`. A spent budget sends no header rather than `0`, because `0` reads one hop later as "the caller asked for nothing" |
| a run the user can actually stop | run it as a job — `agentJob()` — and cancel it by id: `x jobs cancel <id> --reason "user cancelled"` |

## Provider prompt caching

Every turn re-sends the whole transcript, so a run with a long stable prefix — rules, a knowledge-base index — pays for that prefix once per turn. `agent()` asks the provider to cache it: **on by default**.

```ts
import { action, t } from '@ultimat3/action';
import { agent, definePrompt } from '@ultimat3/ai';
import { can } from '@ultimat3/policy';

const readDocument = action({
  input: t.object({ id: t.string }),
  output: t.object({ body: t.string }),
  policy: can('kb:read'),
  mcp: { expose: true, description: 'Read one knowledge-base document by id.' },
  handle: ({ input }) => ({ body: `body of ${input.id}` }),
});

// Your own loader. What it returns must be the same BYTES run to run: sorted, undated.
const knowledgeIndex = async (orgId: string): Promise<string> => `INDEX for ${orgId}\n…`;

const kbPrompt = definePrompt<{ question: string }>({
  id: 'kb',
  version: '1.0.0',
  system: 'Answer from the knowledge base only. Answer through the respond tool.',
  template: 'Question: {{question}}',
});

export const kbAgent = agent({
  model: 'house-large',
  input: t.object({ question: t.string, orgId: t.string }),
  output: t.object({ answer: t.string }),
  prompt: kbPrompt, // its static `system` starts the stable block
  vars: ({ input }) => ({ question: input.question }),
  // Text loaded at run time. `stable` joins the prompt's system in ONE block every run shares;
  // `run` is a second block after it, for whatever differs.
  system: async ({ input }) => ({
    stable: await knowledgeIndex(input.orgId),
    run: `Asked on ${new Date().toISOString().slice(0, 10)}.`,
  }),
  // 'auto' (the default) | 'off' | { session } — a key for hosts that route by one
  promptCache: { session: ({ input }) => `kb:${input.orgId}` },
  tools: [readDocument],
  maxTurns: 10,
  deadlineMs: 120_000,
  policy: can('kb:ask'),
  onTurn: ({ turn, usage, run }) => {
    console.log(`turn ${turn}: read ${usage.cacheReadTokens}, wrote ${usage.cacheWriteTokens}`);
    console.log(`run so far: ${run.cost.minor} ${run.cost.currency}`);
  },
});
```

| Turn | What the provider is asked | What it bills |
|---|---|---|
| 1 | cache the stable system block, and the transcript up to its tail | the prefix as a cache **write** |
| N+1 | the same, with the mark moved to the new tail | turn N's prefix as a cache **read**, only the new tail as a write |
| 1 of the next run | the same stable block, byte for byte | the stable block as a read, while the cache entry lives (5 minutes, refreshed by each read) |

**What is sent depends on the wire and the host** — `PROMPT_CACHE_RULES` in [`prompt-cache.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/ai/src/prompt-cache.ts), first match wins. `As of 2026-10`:

| Provider | Endpoint | Model id | Mark | `session` goes |
|---|---|---|---|---|
| `anthropicProvider()` | any | any | `cache_control: { type: 'ephemeral' }` on the stable system block and the last block of the last two messages — 3 of the 4 breakpoints | nowhere |
| `openAiProvider()` | `openrouter.ai` | `anthropic/…` | the same mark on the stable system **part** and the tail message's last part — 2 breakpoints | `x-session-id` header |
| `openAiProvider()` | `openrouter.ai` | anything else | **none** — Gemini and OpenAI cache implicitly, and an explicit mark on Gemini turns a free cache into a paid write | `x-session-id` header |
| `openAiProvider()` | `api.openai.com` (the default) | any | none — caching is automatic | `prompt_cache_key` body field |
| `openAiProvider()` | any other `baseUrl` | any | none | nowhere |

| Rule | Detail |
|---|---|
| The stable block must be the same **bytes** | a cache is a prefix match. A timestamp, a request id or an unsorted list in `stable` is a full-price write on every call — put it in `run` |
| Below the model's minimum nothing is cached | 512 to 4,096 tokens depending on the model (`ModelSpec.cacheMinimumTokens`); a shorter prefix is processed uncached, with no error |
| `session` is a routing key, not a secret | on OpenRouter it leaves the process in a header: 1 to 256 printable ASCII characters, else `X_AI_REQUEST_INVALID`. On OpenAI a key over 64 characters is sent as a hash of itself (`h:` + 62 hex) — the same key always groups the same requests. OpenAI's guide states no maximum; 64 is a conservative ceiling `As of 2026-10` |
| The Anthropic row matches any host | `anthropicProvider({ baseUrl })` pointed at a proxy still sends `cache_control`: a server speaking that wire is assumed to speak its marks |
| Never an empty block, never a fifth mark | a mark moves back past an empty or whitespace-only text block, or is not sent; marks a raw request already carries count against the vendor's four, and the framework's are dropped first — the message before the tail, then the system block, then the tail |
| More than about 9 tool calls in **one** turn, on OpenRouter | that turn's transcript is not read back: only the tail is marked there, the provider looks back 20 blocks from it, and each call adds two. The next turn pays a write for the transcript; the stable system block still reads |
| No routing preference is ever sent | OpenRouter skips sticky routing when a request orders its providers, and a cache lives on one upstream |
| `llm()` is **off** by default | `promptCache: 'auto'` on an `llm()` that is called many times with one long `system`. A one-shot call that marks its prefix pays the write premium for a cache nothing reads |
| A direct `gateway.generate()` call | `system: { stable, run }` and `promptCache: {}` on the request — the same two fields the loop sets |

**Reading it back.** `onTurn`'s `usage` carries `cacheReadTokens` and `cacheWriteTokens` per turn, `run` carries the running total (`run.usage`, `run.cost`), and the `agent.turn` span event carries `llm.cache.read_tokens` / `llm.cache.write_tokens`. A run whose later turns read nothing has an unstable prefix.

**What it costs.** `costOf` prices a read at the model row's `cacheReadPerMillion` (absent: 0.1x input) and a write at `cacheWritePerMillion` (absent: 1.25x input). A token budget (`tokensPerRun`, `tokensIn`, the gateway's actor and org ceilings) counts **every** token the provider processed — input, output, cache read and cache write, each as one — so caching lowers what a run costs, not how many tokens it is allowed. The pre-flight estimate prices the prompt as a cache write **only when a provider serving the model would actually mark the request** (an Anthropic model; not Gemini, OpenAI or an unknown host, whose estimate is what it was), and at the dearer of the write and input rates — so `costPerCall` holds on turn one.

**Two totals, and which to read.** `run.cost` is the run's usage summed and priced once. The ledger — `gateway.spent()`, and what `costPerCall` and every token ceiling are enforced against — adds each turn's cost, and each turn's cost is rounded **up** to a minor unit on its input half and again on its output half. So the ledger can exceed `run.cost` by under 2 minor units per turn. Enforce on the ledger (declare a `budget`); report `run.cost`.

Measured, 2026-10-11, one three-turn run against OpenRouter with a 19,914-token stable prefix: turn 1 wrote 19,914 tokens and read 0; turn 2 read 19,914 and wrote 72; turn 3 read 19,986 and wrote 68.

## Unattended runs

Three bounds stop a run nobody is watching, beside `maxTurns` and `budget.tokensPerRun`:

| Bound | Default | Reaching it |
|---|---|---|
| `maxRepeatedToolCalls` | **3** | `X_AGENT_TOOL_LOOP` — the most recent tool turns are one cycle gone round that many times: the same turn over and over, or a cycle of 2 or 3 turns (A,B,A,B…). "The same" is the calls, their arguments, the results and whether each failed, so a polled tool whose answer changes is progress and is left alone. A repair turn (a wrong-shaped answer) is not a tool turn: it neither counts nor resets. A longer cycle is `maxTurns`' to stop |
| `deadlineMs` | none | `X_AGENT_DEADLINE` — the run was still going; the model call in flight is aborted on the socket, every tool's own `ctx.signal` fires so a tool that reads it stops, and no further turn starts. A tool that ignores its signal is no longer waited for but **does run to its own end** — its effects can land after the run was refused |
| `maxToolResultChars` | **4,000** | not an error — the result is truncated, and says so in the transcript |

**Under a job.** `X_AGENT_TOOL_LOOP` and `X_AGENT_DEADLINE` are registered `terminal`: an `agentJob()` dead-letters on the first attempt instead of buying the same run once per `retry.attempts`.

A caller that goes away mid-call is `X_ABORTED`, not the transport failure (`X_AI_PROVIDER_UNAVAILABLE`, retryable) the aborted socket used to be reported as. `X_ABORTED` is core's and unclassified, so over HTTP it reads `terminal`; in a job the attempt count stays in charge, and a drain or an attempt timeout is settled by jobs off its own signal as before.

**What a failed run cost.** Every failure thrown by `llm()` or `agent()` after a provider call was started carries the run's bill on `meta.billed`; read it with `billedOf(error)`:

```ts
import type { Billed } from '@ultimat3/ai';
import { billedOf } from '@ultimat3/ai';

declare function recordSpend(runId: string, billed: Billed): Promise<void>;

export async function metered<T>(runId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const billed = billedOf(error); // undefined: no provider call was ever started
    if (billed !== undefined) await recordSpend(runId, billed);
    throw error;
  }
}
```

| Field | Meaning |
|---|---|
| `usage` | the four token counters, summed over every provider call of the run that **answered** |
| `cost` | the price of `usage`, `Money`, rounded up once |
| `calls` | how many calls answered |
| `unsettled` | calls that were started and never reported usage — aborted by the caller or the deadline, cut mid-stream, failed in transport. **Their bill cannot be known**: a provider may charge for what it generated before the socket closed, and usage is the last thing a response carries. They are counted, never estimated, and their budget reservation is given back |

It is the same on `X_LLM_TRUNCATED`, `X_LLM_REFUSED`, `X_LLM_OUTPUT_INVALID`, `X_LLM_TOOL_ARGUMENTS_INVALID`, `X_AGENT_MAX_TURNS`, `X_AGENT_TOOL_LOOP`, `X_AGENT_DEADLINE`, `X_ABORTED`, `X_AI_BUDGET_EXCEEDED` and a transport failure on a later turn. The ledger the run ran under holds the same settled figures. `meta` is operator-only: it is never in a problem document. A throw that is not an `UltimateError` (an `onTurn` that threw a `TypeError`) has no `meta` to carry it; the ledger still does.

## Continuing a run (`.run()` / `.continue()`)

`As of 2026-10`. A plain call returns the answer and keeps nothing. To correct a finished answer without starting over, keep the transcript and continue from it:

```ts
import type { AgentAction, AgentTranscript } from '@ultimat3/ai';
import type { Ctx } from '@ultimat3/core';
import type { t } from '@ultimat3/schema';

type Article = ReturnType<typeof t.object<{ title: typeof t.string }>>;
declare const writeArticle: AgentAction<ReturnType<typeof t.object<{ topic: typeof t.string }>>, Article>;
declare function store(transcript: AgentTranscript): Promise<void>;

export async function writeThenFix(ctx: Ctx, problem: string): Promise<{ title: string }> {
  const input = { topic: 'tides' };
  const first = await writeArticle.run(input, { ctx });
  await store(first.transcript); // JSON; pass back exactly this value
  const second = await writeArticle.continue(
    input,
    { transcript: first.transcript, user: `Fix this and answer again: ${problem}` },
    { ctx },
  );
  return second.output;
}
```

| | |
|---|---|
| `.run(input, opts)` | the same action — policy, audit, rate limit, budget — resolving to `{ output, transcript, turns, usage }` |
| `.continue(input, { transcript, user }, opts)` | appends ONE user turn and resumes the loop. `input` is the run's own input again (the policy and `system()` read it); `vars()` is not called and the prompt is not re-rendered — the transcript holds it. `user` is redacted like the prompt |
| what is re-sent | the whole transcript, byte for byte, then the new turn. A provider has no session, so the tokens are sent again — but the prefix is the one the previous request cached, so it is read at the cache rate, and **no tool runs twice** |
| `maxTurns` | counts the run **and every continuation**: a run that used 5 of 8 has 3 left; one that used them all is `X_AGENT_MAX_TURNS` before a provider call |
| `budget.tokensPerRun` | cumulative too: the ceiling for a continuation is what the earlier calls left; none left is `X_AI_BUDGET_EXCEEDED` before a provider call. The actor and org scopes are charged once per call, as always |
| `deadlineMs`, `maxRepeatedToolCalls` | per call |
| `usage`, `onTurn`'s `run` and `turn` | cumulative across continuations; `meta.billed` on a failure is the failed **call's** own bill |

**The handle is data.** `AgentTranscript` is plain JSON that the app stores; treat it as opaque. It holds what the model was sent (already redacted) and what the tools answered, so store it where tool results may live. On the way back it is screened before anything is loaded or spent — version, the agent (`id@version` of its prompt: a bumped prompt starts a new run), at most `MAX_TRANSCRIPT_CHARS` (2,000,000) of JSON, roles alternating, only the three block kinds a loop writes, and every tool call answered by the next message. Anything else is `X_AGENT_TRANSCRIPT_INVALID` (422). A transcript is not an authority: tools still run as `ctx.actor` under their own policies, so a handle someone edited can mislead the model and nothing else.

## Progress (`onTurn`)

A 90-second agent run emits nothing until it returns. `onTurn` is what a progress indicator, a per-turn spend line and a transcript log read.

```ts
onTurn: ({ turn, maxTurns, model, toolCalls, stopReason, usage, cost }) => {
  // turn is 1-based, so `turn === maxTurns` is the last one this run will take
  // toolCalls are names, in the order the model emitted them — `respond` is not one
  // usage and cost are THIS turn's alone: inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens
  // the event also carries `run` — the running total, this turn included: run.usage, run.cost
},
```

| Field | |
|---|---|
| `cost` | this turn alone, in the currency's minor units, rounded up **once** over the whole turn |
| `costExact` | the same figure exactly — `Money` at a finer `scale` (`{ minor: 450_000, currency: 'USD', scale: 8 }` is 0.45 cents). Absent when an app-written `Provider` states none |
| `run.cost` / `run.costExact` | the run so far, priced once from the summed usage: 14 turns of 0.45 cents are 7 cents, not 14 |
| `repairOf` | on a **repair turn** only: the schema issues of the previous turn's answer — what the model was told to fix before it produced this one |

`llm()` has the same hook per provider call — `onCall({ attempt, model, provider, stopReason, usage, cost, costExact, repairOf, run })` — `attempt` 2 being its one repair turn. It is not called on a semantic-cache hit: nothing was sent.

**Cost is exact, and rounded once.** `exactCostOf(model, usage)` prices a call in micro-units of the currency's minor unit, in integers; `costOf` is that figure rounded up to the minor unit. A ledger (`gateway.spent()`, `BudgetLedger.report()`) sums the exact figures and rounds once when it is read (`cost`, with `costExact` beside it). A price below one minor unit per million tokens is a row with a `scale`: `inputPerMillion: { minor: 75, currency: 'USD', scale: 3 }` is $0.075 per million.

| Rule | Detail |
|---|---|
| Observation only | it cannot steer the loop, cannot see the transcript, and cannot reach the actor |
| Awaited, not guarded | a throw from `onTurn` **fails the run**. It is the app's code on the run's own path, and an observer that silently stopped working reads exactly like one that is fine |
| Always on the span too | the same facts land as an `agent.turn` event, so a run that declares no hook is still readable in a trace |
| Per turn, not per token | tokens on a screen is a different contract |

**There is no `.stream()` on an agent.** `agent()` returns a plain `Action`; only `llm()` returns an `LlmAction`, and that streamed half is one turn deep by construction. A tool call arrives whole — there is nothing to stream between the model deciding to call a tool and the tool answering — so per-turn is the finest granularity a tool loop has.

## `hive()` — many members, one action

Fan one action out over many inputs. The fourth factory over a primitive, after `llm()`, `backfill()` and `agent()`.

```ts
import { t } from '@ultimat3/action';
import { hive } from '@ultimat3/ai';
import { allow } from '@ultimat3/policy';
import { supportAgent } from './support';

export const triageBacklog = hive({
  input: t.object({ orderIds: t.array(t.string) }),
  member: supportAgent,
  split: ({ input }) => input.orderIds.map((orderId) => ({ orderId })),
  concurrency: 8,
  minMembers: 2,
  onMemberError: 'collect',
  budget: { tokensPerRun: 2_000_000 },
  policy: allow(),
});
```

| Field | Required | Default | Behaviour |
|---|---|---|---|
| `member` | yes | — | any action — most usefully an `agent()`, which makes a hive a supervisor over sub-agents |
| `split` | yes | — | the one declared place a run decides what the members are, derived from `input` and `ctx` and from **nothing a model emitted** |
| `onMemberError` | yes | — | `'abort'` or `'collect'`. No default: both are right for somebody |
| `concurrency` | no | **4** | members in flight at once. Deliberately arbitrary — the framework cannot know a provider's allowance |
| `minMembers` | no | **2** | below this the split runs serially. It **drops nothing** — every input still runs |
| `budget` | no | unmetered | `tokensPerRun` covers every member's every turn |

### Three member outcomes, never two

```ts
const result = await triageBacklog({ orderIds }, { ctx });

for (const member of result.members) {
  if (member.status === 'ok')      use(member.index, member.value);
  if (member.status === 'failed')  log(member.index, member.code, member.reason);
  if (member.status === 'skipped') retryLater(member.index, member.reason);
}

result.ok; result.failed; result.skipped; result.tokens; result.cost;
```

| Arm | Means |
|---|---|
| `ok` | the member ran and returned. `value` is the member's own `output`, embedded verbatim — so a hive over `supportAgent` publishes an answer in its OpenAPI response and its MCP `outputSchema`, not an opaque object |
| `failed` | the member ran and threw. `code` is the `UltimateError` code, or `'unknown'` for a foreign throw; `reason` is its cause |
| `skipped` | the member **never ran** — a sibling failed under `onMemberError: 'abort'` |

*Ran and threw* and *never ran* are different facts, and collapsing them makes "the hive stopped early" read as "every remaining item is bad data" — which is the difference between retrying the tail and fixing the source. `index` is on every arm, so a result joins back to the row it came from without depending on array position surviving a filter.

| Rule | Why |
|---|---|
| `members` comes back in **split order**, failures included | a hand-rolled `Promise.all` reports in completion order, and joining a result back to its row then silently depends on nothing having failed |
| The hive **never names an actor** | each member runs through the member action's own callable, so `invoke` applies its policy with `ctx.actor` untouched |
| An empty split is `X_HIVE_EMPTY` | `0 ok, 0 failed` cannot be told apart from a query that returned no rows and nobody noticed |
| An aborted `ctx` unwinds the whole hive | distinct from `onMemberError: 'abort'`, which is a completed run with a partial harvest worth returning — here there is nobody left to hand it to |
| `skipped` is published beside `ok` and `failed` | three arms and two counters means `members.length - ok - failed`, and a caller who writes that once writes it wrong once |

## `agentJob()` — an agent as durable background work

```ts
import { agentJob } from '@ultimat3/ai';
import { supportAgent } from './support';

export const triageJob = agentJob(supportAgent, {
  name: 'support-triage',
  tenant: 'none',
  retry: { attempts: 3, backoff: 'exponential' },
});
```

`As of 2026-08` this is the **only** way an agent reaches a queue. `.job()` hands back `kind: 'action-job'`, and `isJobHandle` needs `kind === 'job'` plus membership of a `WeakMap` only `job()` writes, so nothing externally shaped has ever reached the registry, the worker or the dead-letter path.

| Field | Required | Behaviour |
|---|---|---|
| `name` | yes | the durable queue key, never derived from an export name — queued, retrying and dead-lettered rows already carry it, so renaming an export must not move where they are delivered |
| `tenant` | yes | the org this run's body acts under. `'none'` is the explicit statement that it touches no tenant-scoped table, and then every scoped read inside it fails closed |
| `retry` | yes | a model call fails transiently; how many times is nobody else's guess |
| `queue` | no | |
| `idempotencyKey` | no | defaults to the action projection's `action:<name>:<fingerprint of input>` |
| `actor` | no | `({ input, ctx }) => Actor` — who the run acts FOR, re-resolved on every attempt from the id its input carries. Without it the agent runs as the worker, whose actor is **anonymous** in a served app, so a member policy refuses it `X_UNAUTHENTICATED`. Swapped in through core's `impersonate` (the worker stays on the record as `onBehalfOf`); an actor outside the declared `tenant` is `X_JOB_TENANT_MISMATCH` before the agent starts — terminal, dead-lettered on attempt 1, since the same payload resolves the same actor every time |

It composes `job()` rather than imitating a handle, so `.enqueue()`, the outbox, the worker's cancellation, the dead-letter path, `x jobs show` and its manifest row all arrive for free. One execution path, and it is the action's: `invoke(agent, input, { surface: 'job', ctx })`, so the agent's policy, input parse, budget scope and span all apply — and `ctx` is the **worker's**, so an attempt timing out aborts the turn loop.

**A queued run's return value is not stored** — `x_jobs` keeps no result column. So `agentJob` wraps an ACTION that runs the agent and keeps the answer itself, and the agent stays read-only.

> **Rule: never hand the model a write tool whose target it chooses.** The model reads text someone else wrote — a draft, a ticket, a scraped page — and "now record this for record X" is an instruction a model may follow. A write tool is a write that text can aim. The wrapping action binds the target from its OWN input.

Worked example: the reference app's `keepDraftReview` → `reviewDraftLater` (`examples/dummy/apps/web/app/posts/actions/keep-draft-review.ts`, `jobs/review-draft-later.ts`). `reviewDraft` is an agent with one read tool; `keepDraftReview` runs it and upserts the verdict on the post id it was given — `(orgId, postId)` is the key, so a replayed run is the same row — under `postReviewKeep`, the publishing right, never `post:read`; `reviewDraftLater = agentJob(keepDraftReview, { actor })`; the `postReview` query reads it back. `review.job.test.ts` drives it on the production worker, with a model that tries to write onto another post and has nothing to write with.

### The at-least-once trap

> **Rule you must satisfy: every write an `agentJob` run makes — by the wrapping action or by any tool — is idempotent. The framework does not and cannot check this.**

**`idempotencyKey` dedupes the ENQUEUE, never the ATTEMPT.**

Two `enqueue` calls with the same payload are one row. One row that a worker claims, half-runs and loses the lease on is claimed again — and **the agent runs a second time from the top**. Every turn re-executes. Every tool call re-executes.

So **every write a run makes has to be idempotent** — the wrapping action's, and any tool's: an `upsertAll`, an `updateWhere`, a statement whose second run changes nothing. Otherwise a replayed attempt issues a second refund against the same order. Idempotent is not aimed: a write the run needs belongs in the wrapping action, bound to its input, not in a tool the model points.

The same holds one level up: `backfill()`'s `handle` is at-least-once by construction — it runs before its checkpoint lands — so an attempt cancelled between the two replays that page, and re-runs every agent on it.

**The framework does not check this, and cannot.** `mutates` is not a fact an `action()` declares — it exists only in `@ultimat3/mcp`, which sets it to `true` for *every* action it projects — so a read-only `lookupOrder` and a destructive `issueRefund` are indistinguishable at this seam. A rule refusing every tool that had not declared `idempotent: true` would refuse the reads too, and a wrong refusal is worse than a stated obligation. This is a contract you keep, not one the compiler keeps for you.

| Make it idempotent by | Example |
|---|---|
| A natural key the second run collides with | `issueRefund` keyed on `(orderId, amountMinor)`, written with `upsertAll(..., { onMatch: 'nothing' })` |
| A statement whose second run changes nothing | `updateWhere({ status: 'pending' }, { status: 'refunded' })` |
| Never | `count + 1`, an append-only log line, a `POST` to a vendor with no idempotency key |

## Millions of rows

Three primitives, each doing the job the others cannot:

| Layer | Primitive | What it owns |
|---|---|---|
| the sweep | `backfill()` | resumable pages, a cursor persisted per `step.run`, mandatory pacing, an environment gate, the `x_backfills` ledger |
| the page | `hive()` | bounded concurrency inside one page, split-order results, three-way member outcomes, one derived ledger |
| the run | `agent()` | the turn loop, the tools, `tokensPerRun` |

```ts
import { database, entity, text, timestamp, uuid } from '@ultimat3/entity';
import { backfill } from '@ultimat3/jobs';
import { triageBacklog } from './triage';

const orders = entity('orders', {
  columns: { id: uuid().primaryKey(), status: text(), createdAt: timestamp().defaultNow() },
});

const db = database({ orders });

export const triageEveryOrder = backfill({
  name: 'triage-every-order',
  tenant: 'none',
  environments: ['staging', 'production'],
  batch: 200,
  rate: 1,                                    // batches per second — there is no unthrottled mode
  source: () => db.orders.where({ status: 'needs-triage' }),
  count: () => db.orders.where({ status: 'needs-triage' }).count(),
  handle: async ({ rows, ctx }) => {
    await triageBacklog({ orderIds: rows.map((row) => row.id) }, { ctx });
  },
});
```

| Ceiling | Where it goes |
|---|---|
| per model call | `budget.costPerCall` on the `agent()` |
| per agent run | `budget.tokensPerRun` on the `agent()` |
| per page | `budget.tokensPerRun` on the `hive()` — every member's every turn |
| per actor, per org, **fleet-wide** | `providerGateway({ budget: { actor, org }, budgetStore })`. The default `memoryBudgetStore()` is per process; a shared store is what makes these mean anything above one replica |
| rows per second | `backfill`'s `rate` and `batch`. This pass shares its pool with the requests the app is still serving |
| which deploys sweep at all | `backfill`'s `environments`. A mismatch is `X_BACKFILL_ENVIRONMENT`, refused inside the pass as well as by the CLI |

`x db backfill --pending` lists declared sweeps the ledger has never completed; `x db backfill <name> --write` enqueues one. Full detail: [Migrations and backfills](Migrations-And-Backfills).

## `describeAgents()`

```ts
import { describeAgents } from '@ultimat3/ai';

describeAgents();
// [{ name: 'supportAgent', prompt: 'support@1.0.0', promptId: 'support', promptHash: '…',
//    model: 'house-large', modelFrom: 'declaration', maxTurns: 6, maxToolResultChars: 4000,
//    tools: ['issueRefund', 'lookupOrder'],
//    budget: { tokensIn: null, tokensPerRun: 200000, costPerCall: { minor: 50, currency: 'USD' } },
//    mcp: true }]
```

An agent projects to an `ActionDescriptor` like every other action, and that descriptor knows nothing about turns or tools — so "how far can this loop, and what may it call" had no answer outside the source. `tools` is the agent's **blast radius**, sorted. `promptHash` is there because an agent's behaviour is its prompt: a row without one records which agent ran and not which agent it *was*. `modelFrom` says which place answered `model` — `declaration`, `prompt` or `gateway`; both are `null` when none names one yet (a call in that state is refused). `gateway` and `null` are as of the gateway installed when the row is read. Reading a row never throws.

Names are read when you ask, not when the agent was declared: `registerAction` stamps them at boot, long after `agent()` ran at module scope. An agent nothing registered has **no row**, and that is not a silent drop — an action with no name reaches no route, no tool catalogue and no queue, so there is no capability for a row to describe. Register it: `registerAction('supportAgent', support)`.

## No semantic cache

`llm()` has one. `agent()` deliberately does not.

Similar prompts do not have similar answers once the answer depends on what `lookupOrder` returned this second, and a cache over that would serve one run's world state to another. A prompt version bump plus the tools' own caching is the story. The gateway's exact-match response cache still applies per model call, and a **refusal is never cached** — a cached one keeps serving a classifier decision after the prompt was fixed.

## Errors

| Code | Cause | Fix |
|---|---|---|
| `X_AGENT_TOOL_UNEXPOSED` | a `tools` entry declares no `mcp` block, or `mcp: { expose: false }`. Raised at **declaration** | add `mcp: { expose: true, description }` to the action `cause` names, or drop it from `tools` |
| `X_AGENT_MAX_TURNS` | the loop used every turn calling tools and never answered | tell the template when to stop and answer through the respond tool, then bump its version |
| `X_AGENT_TOOL_LOOP` | consecutive turns made the same tool calls and read the same results | `maxRepeatedToolCalls: 5` on the agent, only for a tool that really is polled; otherwise tell the template what to do when the result does not change, then bump its version |
| `X_AGENT_DEADLINE` | the run outlived its declared `deadlineMs` | `deadlineMs: 300_000` on the agent, once a trace shows the run converging; otherwise lower `maxTurns` |
| `X_LLM_OUTPUT_INVALID` | every turn's answer failed the `output` schema | describe the shape in the template and bump its version, or widen `output` |
| `X_LLM_REFUSED` | the provider's classifiers declined; `stopDetails.category` names why | set `model:` to the more capable one the thrown `fix:` names, or edit the template and bump its version |
| `X_LLM_TRUNCATED` | a turn hit `maxTokens` before finishing — read before the answer, so nothing truncated is ever validated or run. A tool call cut off mid-arguments is this code too, streamed or not | raise `maxTokens:` on the declaration, or drop fields from `output`. A model that reasons spends the same ceiling on reasoning: a measured 28,000-character answer used 12,954 output tokens |
| `X_AGENT_TRANSCRIPT_INVALID` | `.continue()` was handed a transcript that did not pass its screen | start a new `.run()` and store its transcript; pass back exactly the value returned, to the same agent and prompt version |
| `X_LLM_TOOL_ARGUMENTS_INVALID` | the turn finished and a tool call's arguments are not JSON. Billed (`meta.billed`), recorded on the ledger, not retried by the gateway | `retry: { attempts: 2 }` on the job; if it repeats, shorten or split the string fields of that tool's input schema |
| `X_HIVE_EMPTY` | `split()` produced zero members | return at least one member input, or guard the call site |
| `X_AI_BUDGET_EXCEEDED` | refused pre-flight, naming the scope and what remains | raise that scope's ceiling, or shorten the prompt |
| `X_AI_PROMPT_SECRET` | `vars()` returned a `Secret` | drop the key from `vars()` and the template, or `revealSecret(value)` if the model genuinely has to read it |
| `X_AI_GATEWAY_MISSING` | the agent ran before `configureAi`; the cause lists the peer providers | `configureAi({ gateway: providerGateway({ providers: [provider] }) })` at boot, with `provider` your choice — [above](#register-your-models-pick-your-provider) |
| `X_ABORTED` | `ctx.signal` fired mid-run | pass a longer deadline, or run it as a job |

Full list: [Error codes](Error-Codes).

## Rules

- `agent()` is a factory over `action()`. A new capability arrives as a factory over an existing primitive, never as a new kind of thing.
- Tools are real `action()`s, each `mcp: { expose: true }`, each deciding its own calls with its own policy.
- The actor is `ctx.actor`, read once. A model can never name the identity it acts as.
- Structured output is the forced `respond` tool. There is no JSON mode and no second structured-output path.
- Tools of one turn run concurrently and are paired positionally; turns are serial.
- A budget refuses, never truncates, and the ceiling holds under parallelism because the reservation debits before the call.
- `ctx.signal` unwinds the run at every turn boundary, before every tool batch, and on the socket.
- `onTurn` observes and cannot steer. There is no `.stream()` on an agent.
- Every turn asks the provider to cache its prefix unless `promptCache: 'off'`; what is sent is a row in `PROMPT_CACHE_RULES`, never an `if`.
- A run that repeats itself is stopped (`X_AGENT_TOOL_LOOP`); a run with a `deadlineMs` is stopped at it (`X_AGENT_DEADLINE`).
- A hive reports in split order with three member arms; an empty split is an error.
- `idempotencyKey` dedupes the enqueue, never the attempt — every tool an agent may call must be idempotent, and nothing checks it for you.

Source: [`packages/ai/src`](https://github.com/developerz-ai/ultimate/blob/main/packages/ai/src)
