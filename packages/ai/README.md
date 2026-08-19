# @ultimat3/ai 🧠

The LLM gateway primitive. Every model call in an Ultimate app goes through it, so budgets
and cost accounting cannot be bypassed by a stray `fetch`.

```ts
import { createGateway, AnthropicProvider, EchoProvider } from '@ultimat3/ai';

export const ai = createGateway({
  providers: [new AnthropicProvider(), new EchoProvider()],   // ANTHROPIC_API_KEY, or { apiKey }
  budget: { request: 40_000, actor: 500_000, org: 20_000_000 },  // tokens
  cache: memoCache,
});

// Budgets are scoped, and every nested call inside the scope shares one ledger.
const answer = await ai.scope({ actorKey: actor.id, orgKey: actor.orgId }, async () => {
  const { text } = await ai.generate({
    model: 'claude-opus-5',
    system: 'You summarise support tickets.',
    messages: [{ role: 'user', content: ticket.body }],
    maxTokens: 1_024,
    effort: 'high',
  });
  return text;
});
```

## Budgets — and which of the three is fleet-wide

`request` is one call chain. `actor` and `orgs` are counters across calls, so where they live
decides what they mean:

| `budgetStore` | `actor` / `org` counts | Right for |
|---|---|---|
| omitted — `MemoryBudgetStore` (the default) | **per process**, and reset on every deploy | `x dev`, tests, a single-replica app |
| your own `BudgetStore` | fleet-wide | anything with more than one replica |

```ts
import { AnthropicProvider, type BudgetStore, createGateway } from '@ultimat3/ai';

declare const redis: {
  incrby(key: string, by: number): Promise<number>;
  del(key: string): Promise<unknown>;
  flushdb(): Promise<unknown>;
};

const sharedBudget: BudgetStore = {
  spent: (key) => redis.incrby(key, 0),
  add: async (key, tokens) => {
    await redis.incrby(key, tokens);
  },
  reset: async (key) => {
    await (key === undefined ? redis.flushdb() : redis.del(key));
  },
};

export const sharedGateway = createGateway({
  providers: [new AnthropicProvider()],
  budget: { request: 40_000, actor: 500_000, org: 20_000_000 },
  budgetStore: sharedBudget,
});
```

Three methods, and `add` takes a **negative** `tokens` — releasing a reservation the call never
spent is a credit, so a store that clamps at zero leaks the ceiling. `org: 20_000_000` on the
default store at `replicas: 6` is six ledgers of twenty million, which is a budget that is not one.

## Rules the gateway enforces

| Rule | Why |
|---|---|
| A budget **refuses**, never truncates | a shortened prompt yields a confidently wrong answer with no signal |
| Cost is **integer minor units** (`@ultimat3/money`) | token spend is money; the house rule has no exception |
| Cost rounds **up** | a rounded-away fraction is money the framework absorbs and a budget under-reports |
| `temperature` / `top_p` / `top_k` are never sent | rejected with a 400 on every current model — steer with the prompt |
| `effort` goes in `output_config` | a top-level `effort` is silently ignored |
| The reasoning half of the body is **per model** | `effort` and adaptive thinking arrived with 4.6; sending them to an older model is a 400 on every request |
| A control the model lacks is **refused**, never dropped | a declaration reading `effort: 'max'` that quietly runs at the default is the failure nobody can see |
| A control nobody asked for is **omitted**, never defaulted | a default sent as a request is indistinguishable on the wire from one that was declared |
| A refusal is `X_LLM_REFUSED`, not a schema failure | it is a 200 with no answer in it, and a repair turn buys the same refusal again |
| The refusal's `alternative` is only ever a **more capable** model | registration order is most-capable-first and `moreCapableThan` walks it upward; retrying a refusal on a weaker model is the one retry that cannot help, so an unbeatable model gets no suggestion at all |
| Fallback is across **providers serving one model**, never across models | a silent model swap changes what answered, what it cost and which eval baseline the answer belongs to; the gateway stamps `result.provider`, and `llm()` puts it on the span as `llm.provider`, so the fallback that does exist is never silent |
| The repair turn replays the tool call's arguments, never an empty `text` | an answer through the `respond` tool leaves `text` empty, and an empty text block is a 400 — the repair came back as `X_AI_PROVIDER_UNAVAILABLE` |
| `reserve()` **debits** the estimate and takes a turn | three concurrent calls otherwise read the same `spent()`, all pass, and all three record against a ceiling only one of them fitted; `record` reconciles and `release` gives it back |
| A refusal is never cached | a cached one keeps serving a classifier decision after the prompt was fixed |
| Retries use **full jitter** | synchronised retries from N workers reproduce the rate limit |
| A 4xx is never retried | the same body gets the same rejection and burns the budget |

## Streaming

`stream()` yields as the model writes and ends with one `done` chunk carrying the assembled
result — so a consumer that only wants the answer can ignore everything before it. Required
above `STREAM_ONLY_MAX_TOKENS` (16k): a non-streaming request that large hits the HTTP timeout
after the completion has already been generated and billed. `generate()` switches to this
transport by itself above the ceiling and returns the assembled result — the limit belongs to
the transport, so it is not one the caller has to change API for.

```ts
for await (const chunk of ai.stream({ messages, maxTokens: 64_000 })) {
  if (chunk.type === 'text') process.stdout.write(chunk.text);
  if (chunk.type === 'tool-call') await runLlmToolCall(tools, chunk.call, actor);
  if (chunk.type === 'done') debit(chunk.result.cost);   // real usage, not the estimate
}
```

| Rule | Why |
|---|---|
| A `tool-call` chunk arrives whole | `input_json_delta` fragments are not arguments until the block closes |
| `thinking` chunks never join `text` | concatenating every chunk must not ship the reasoning to the user |
| A stream cut before `message_stop` **throws** | a truncated answer reporting `end_turn` is wrong with no signal |
| `[DONE]` with a tool call still open **throws** | the OpenAI format has no per-call stop event, so the finish reason is the only close there is; the sentinel alone cannot tell "finished asking" from "cut mid-arguments" |
| A body with no frame boundary in it **throws** | an SSE peer that never completes a frame is an unbounded allocation no read deadline interrupts |
| An in-band `error` frame carries a status | `overloaded_error` mid-stream retries like a 529 on the handshake |

## Embeddings

`RemoteEmbedder` speaks the one `/v1/embeddings` shape every hosted and self-hosted embedder
uses; `baseUrl` selects the provider. `HashEmbedder` is the deterministic offline twin `x dev`
and the test suite run on.

```ts
const embedder = new RemoteEmbedder({ name: 'voyage-3', dimension: 1_024 });  // EMBEDDINGS_API_KEY
```

Vectors are L2-normalised on arrival, so `cosine` stays a dot product. A width other than the
declared `dimension` is `X_VECTOR_DIM_MISMATCH` **before** anything reaches a store — a store
half-written at the wrong width has no error to report, only worse answers.

## The model catalogue is open

`ModelId` is a **`string`**, and the catalogue is a registry. Your own gateway, Bedrock, Azure,
Vertex, a fine-tune, a negotiated rate — all expressible, none needing a fork.

```ts
registerModel({
  id: 'llama-internal-70b',
  contextWindow: 128_000,
  maxOutput: 8_192,
  inputPerMillion:  { minor: 20, currency: 'USD' },   // YOUR price, integer minor units
  outputPerMillion: { minor: 40, currency: 'USD' },
  cacheMinimumTokens: 0,
  reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
});

configureAi({ gateway: createGateway({ providers: [new InternalGatewayProvider()] }) });
```

**The three built-ins register through this same call.** There is one way to put a model in the
catalogue, and the default path is the app's path. Re-registering an id replaces its spec and keeps
its rung — which is how a negotiated enterprise rate is expressed, and why there is no second
`overrideModel` call. An id nothing registered is `X_AI_MODEL_UNKNOWN` at the first read, naming
the registered set; that check is what replaced the closed union, so a wrong id is still caught
without making a right one inexpressible.

Registration order is the capability ladder, most capable first — `moreCapableThan` is its only
reader, and `X_LLM_REFUSED`'s fix line the only thing that acts on it.

Built in, `As of 2026-08`:

| Model | Context | Max output | Input / MTok | Output / MTok | `effort` | adaptive thinking |
|---|---|---|---|---|---|---|
| `claude-opus-5` (default) | 1M | 128K | $5 | $25 | yes | yes, off only at `effort ≤ high` |
| `claude-sonnet-5` | 1M | 128K | $3 | $15 | yes | yes |
| `claude-haiku-4-5` | 200K | 64K | $1 | $5 | no — a 400 | no — a 400 |

The last two columns are data on the spec, not prose: `body()` builds the reasoning half from
them, so a downgrade for price cannot become a request the provider rejects.
`AnthropicProvider.models` is its own list, never the registry's — your internal model is not
routed to Anthropic.

## The OpenAI **format** — Azure, vLLM, Ollama, your own gateway

`openAiProvider()` speaks the OpenAI chat-completions **wire format**, not one vendor. Azure
OpenAI, vLLM, Ollama, LiteLLM, OpenRouter, Together and most self-hosted company gateways serve
that format, so "point Ultimate at our internal model gateway" is a `baseUrl` and a `models` list.

```ts
import { openAiProvider, OPENAI_MODEL_IDS, createGateway, configureAi } from '@ultimat3/ai';

// OpenAI itself. `apiKey` takes a `Secret`; OPENAI_API_KEY is read when it is omitted.
openAiProvider({ apiKey: env.OPENAI_API_KEY, models: [...OPENAI_MODEL_IDS] });

// Azure OpenAI — the deployment URL as written, api-version query and all. `models` are
// DEPLOYMENT names on Azure, and the key rides in `api-key`, not `Authorization`.
openAiProvider({
  apiKey: env.AZURE_OPENAI_KEY,
  auth: 'api-key',
  baseUrl: 'https://acme.openai.azure.com/openai/deployments/prod?api-version=2026-05-01',
  models: ['prod'],
});

// vLLM / your own gateway, on the cluster. Register the model first — nothing can price an id
// the catalogue has never heard of.
openAiProvider({
  apiKey: env.GATEWAY_TOKEN,
  baseUrl: 'https://llm.acme.internal/v1',
  models: ['llama-internal-70b'],
  name: 'acme-gateway',            // what `result.provider` and `llm.provider` will say
  headers: { 'x-team': 'platform' },
});

// Ollama, on a laptop. The key is required and ignored, exactly as Ollama's own docs have it.
openAiProvider({ apiKey: 'ollama', baseUrl: 'http://localhost:11434/v1', models: ['qwen3'] });
```

Priced built-ins — list price from `developers.openai.com/api/docs/pricing`, read **2026-08-16**:

| Model | Context | Max output | Input / MTok | Output / MTok | `reasoning_effort` |
|---|---|---|---|---|---|
| `gpt-5.6-sol` | 1.05M | 128K | $5 | $30 | yes |
| `gpt-5.6-terra` | 1.05M | 128K | $2 | $12 | yes |
| `gpt-5.6-luna` | 1.05M | 128K | $0.20 | $1.20 | yes |

Three, and no more, on purpose: `gpt-4o` and the `o1` family cache at **0.5x** input where `costOf`
assumes 0.1x, and the `pro` tiers publish no cached rate at all. A wrong price is worse than a
missing one — `costOf` answers confidently either way, and the missing entry says so with
`X_AI_MODEL_UNKNOWN`. Register those yourself, at the rate your own contract names.

| Rule | Why |
|---|---|
| **Structured output is the `respond` tool**, never `response_format` | `llm()` already projects `output` into one tool and reads the answer out of the tool call; `json_schema` + `strict` would be a second structured-output path (axiom 1) and is the one feature most OpenAI-*compatible* servers do not implement |
| `tool_choice` is forced when the request offers **exactly one** tool | one tool is nothing to choose between, and that is precisely `llm()`'s shape. A tool loop (`agent()`) is never forced — that would decide the model's next step for it |
| `strict: true` is claimed only when the schema **can keep the promise** | on this wire `strict` is checked by the server: one optional field and the request is a 400. The flag is derived from the projected schema, never forwarded |
| `max_completion_tokens`, never `max_tokens` | the old field is rejected outright by every current reasoning model |
| `stream_options: { include_usage: true }` on every streamed call | without it the final chunk carries no `usage`, and the budget reconciles a real call against nothing |
| Usage absent anyway → **estimated**, never zero | a compatible server that ignores `stream_options` would otherwise refund the whole reservation |
| `prompt_tokens` minus `cached_tokens` is the input count | this format counts the cached prefix inside `prompt_tokens`; Anthropic's excludes it, and reporting it as-is bills the cached half twice |
| Tool-call deltas are merged by `tool_calls[].index` | id and name arrive on the first fragment only — merging by array position builds one call per chunk |
| A tool call is emitted **whole**, at the finish reason | there is no per-block stop event here, and a fragment is not an argument list |
| `role: 'system'`, not `developer` | every other server in the family knows only `system`, and OpenAI accepts it |
| A refusal (`message.refusal`, or `finish_reason: 'content_filter'`) is `X_LLM_REFUSED` | it is a 200 with no answer in it, exactly as on the Anthropic path |
| The API key is revealed as late as possible, and scrubbed out of error detail | a proxy that echoes request headers into its 4xx body is the one path by which a key reaches a log index |

`thinking` maps onto the one field this format has: `'disabled'` is `reasoning_effort: 'none'`,
`effort` is `reasoning_effort` as written, and asking for both is `X_AI_REQUEST_INVALID` rather
than a silent pick. A model registered with `reasoning: { effort: false }` refuses both locally, so
a llama behind vLLM never gets a field it would reject.

## `llm()` — a model call, declared as an action

Not a ninth primitive. A model call has an input schema, an output schema and a policy, which
is an `action` — so `llm()` returns one, and everything an action projects, it projects.

```ts
import { llm, t } from '@ultimat3/ai';
import { can } from '@ultimat3/policy';

export const summarize = llm({
  model:  'claude-sonnet-5',
  input:  t.object({ postId: t.uuid }),
  output: t.object({ summary: t.string, tags: t.array(t.string) }),
  prompt: summarizePrompt,                                       // versioned artifact
  vars:   async ({ input, ctx }) => ({ body: await ctx.posts.body(input.postId) }),
  cache:  { semantic: { threshold: 0.97, ttl: '7d', scope: ({ orgId }) => orgId } },
  budget: { tokensIn: 8_000, costPerCall: { minor: 5, currency: 'USD' } },
  policy: can('post:read'),
});

summarize.tool();        // an MCP tool, gated by the same policy object
summarize.openapi();     // an HTTP operation
summarize.job();         // a job handle, for the long chains
summarize.contract();    // the contract tests
```

| Declared | Behaviour |
|---|---|
| `output` | projected into the one tool the model may answer through; prose with a fenced JSON block still parses |
| a schema failure | **one** repair turn naming the issues, then `X_LLM_OUTPUT_INVALID` |
| `budget` | reserved against the worst case **before** the provider is reached — nothing spent, nothing truncated |
| `cache.semantic` | one store per scope, keyed by embedding; a prompt version bump reaches a different store, so the bump *is* the invalidation |
| `policy` | the same object every surface evaluates — an MCP call and an HTTP call are denied identically |
| `vars` | the one declared place a model call loads data, so a reader can see what was sent — and the one place a redactor sees it, and where a `Secret` is refused |

### Streaming is the same action

```ts
for await (const chunk of summarize.stream({ postId }, { ctx })) {
  if (chunk.type === 'text') write(chunk.text);
  if (chunk.type === 'done') save(chunk.value);   // validated against `output`
}
```

Policy, input parse, budget scope, semantic cache, span, audit and `.tool()` all still apply: the
invocation is an ordinary one, marked so the model half streams. Two consequences worth knowing:

| Decision | Why |
|---|---|
| the `done` chunk carries the validated value; text increments are **unvalidated** | a schema cannot be checked until the last token has landed |
| **no repair turn** — a bad shape is `X_LLM_STREAM_INVALID` | the consumer has already read the tokens; a second answer over the top is two answers to one question. The fix names the non-streaming call |
| the budget is reserved **before the first token** and reconciled at `done` | unchanged from `generate()`; a stream that throws or is abandoned releases in a `finally` |
| no `respond` tool is offered | a tool call is emitted whole, so forcing one leaves nothing to stream — the answer is prose, and its JSON parse is what a non-string `output` validates |
| lazy | nothing is authorised, budgeted or sent until the first pull |

## `agent()` — the tool loop, also an action

The second half of "no ninth primitive": a tool-using run is still one server-authoritative
operation with an input schema, an output schema and a policy.

```ts
export const support = agent({
  input:  t.object({ orderId: t.string }),
  output: t.object({ answer: t.string }),
  prompt: supportPrompt,
  vars:   ({ input }) => ({ orderId: input.orderId }),
  tools:  [lookupOrder, issueRefund],          // real actions, each mcp.expose
  maxTurns: 6,
  maxToolResultChars: 4_000,
  budget: { tokensPerRun: 200_000, costPerCall: { minor: 50, currency: 'USD' } },
  policy: can('order:support'),
  onTurn: ({ turn, toolCalls, cost }) => progress.push({ turn, toolCalls, cost }),
});
```

`tools` takes the `action()` an app already wrote — `[lookupOrder, issueRefund]`, the imports
themselves. `As of 2026-08`: it took a hand-shaped `ProjectableAction` until then, so the line
above was a `TS2741` against every real action (issue #124) and the only thing that satisfied it
was a stand-in written for a test.

An `agent()` returns an action, so **an agent is a tool of another agent** — a supervisor lists a
sub-agent in its own `tools` and the sub-agent runs under the same actor, through the same policy.
No `hive()`, no supervisor primitive: it falls out of the factory rule.

| Rule | Why |
|---|---|
| the actor is **`ctx.actor`**, read once, never from the model | this is the mistake a hand-rolled loop ships, and the reason the loop belongs in the framework |
| an aborted `ctx` unwinds the run — at the top of every turn, before every tool batch, and on the socket | the transcript IS the request, so a loop that keeps going after the caller disconnects re-sends it once per remaining turn, runs every remaining side effect and discards the answer. `ctx.signal` rides on `GenerateRequest` too, so a call already in flight is cut rather than paid for |
| the tools of **one turn** run concurrently, results paired by `tool_use` id | a turn asking for five tools cost 5x wall clock and nothing said so. Order is positional, never by completion; the batch is bounded by what one turn asked for, and each tool is an action with its own `policy` and `rateLimit`, so a second ceiling here would be a throttle competing with those |
| `onTurn` reports each completed turn as it happens (and an `agent.turn` span event, always) | a 90-second run emitted nothing until it returned. Observation only — it cannot steer the loop, see the transcript or reach the actor — and a throw from it fails the run rather than being swallowed |
| a tool that is not `mcp: { expose: true }` is `X_AGENT_TOOL_UNEXPOSED` **at declaration** | a silently dropped tool reads as offered and is not; `isMcpExposed` is the one predicate, so an in-app agent and an external MCP client see the same catalogue |
| running out of turns is `X_AGENT_MAX_TURNS`, never a partial answer | a half-finished transcript returned as a result is working notes presented as a decision |
| `budget.tokensPerRun` caps the **whole run** | a single call is bounded by `maxTokens`; a loop is bounded by nothing until this is set |
| a tool result is truncated, and says so | the transcript IS the request, so an untruncated result is re-billed once per remaining turn |
| **no semantic cache** | similar prompts do not have similar answers once the answer depends on what `lookupOrder` returned this second |

## `hive()` — many members, one action

Fan an action out over many inputs. The fourth factory over a primitive, after `llm()`,
`backfill()` and `agent()`: a fan-out is still one server-authoritative operation with an input
schema, an output schema and a policy.

```ts
import { action, t } from '@ultimat3/action';
import { hive } from '@ultimat3/ai';
import { allow } from '@ultimat3/policy';

const summarisePost = action({
  input: t.object({ postId: t.uuid }),
  output: t.object({ summary: t.string }),
  policy: allow(),
  mcp: { expose: true },
  handle: ({ input }) => ({ summary: input.postId }),
});

export const summariseBacklog = hive({
  input: t.object({ postIds: t.array(t.uuid) }),
  member: summarisePost,
  split: ({ input }) => input.postIds.map((postId) => ({ postId })),
  concurrency: 8,
  minMembers: 2,
  onMemberError: 'collect',
  budget: { tokensPerRun: 500_000 },
  policy: allow(),
});
```

`member` is any action — most usefully an `agent()`, which makes a hive a **supervisor over
sub-agents** with no supervisor primitive anywhere.

| Rule | Why |
|---|---|
| `members` comes back in **split order**, with `index` on every arm | a hand-rolled `Promise.all` reports in completion order, so joining a result back to the row it came from silently depends on nothing having failed |
| three arms — `ok`, `failed`, `skipped` — never two | *ran and threw* and *never ran* are different facts, and an aborted sibling is the second. Collapsing them makes "the hive stopped early" read as "every remaining item is bad data" |
| `onMemberError` is **required** | `'abort'` stops and leaves the rest `skipped`; `'collect'` harvests the rest. Both are right for somebody, so neither is a default |
| the hive **never names an actor** | `split` derives member inputs from `input` and `ctx` and from nothing a model emitted; each member runs through its own callable, so `invoke` applies the member's own policy with `ctx.actor` untouched |
| `concurrency` bounds the fan-out; one derived ledger bounds the spend | the ceiling holds under parallelism because the budget's root turnstile debits before the call, so three members against a ceiling only one fits leave exactly one `ok` — no hive-specific budget code exists |
| an empty split is `X_HIVE_EMPTY` | "0 ok, 0 failed" cannot be told apart from a query that returned no rows and nobody noticed |
| `minMembers` (default 2) stops fanning out, and **drops nothing** | a member's fixed cost dominates trivial work; below the floor every input still runs, serially |
| an aborted `ctx` unwinds the whole hive with `X_ABORTED` | distinct from `onMemberError: 'abort'`, which is a completed run with a partial harvest worth returning — here there is nobody left to hand it to |

## `agentJob()` — an agent as durable background work

Run an agent over a million rows as resumable, retried, budgeted queue work. `As of 2026-08` this
is the only way an agent reaches a queue at all: `.job()` hands back `kind: 'action-job'`, and
`isJobHandle` needs `kind === 'job'` plus membership of a `WeakMap` only `job()` writes, so nothing
externally shaped has ever reached the registry, the worker or the dead-letter path (issue #125).

```ts
import { t } from '@ultimat3/action';
import { agent, agentJob, definePrompt } from '@ultimat3/ai';
import { allow } from '@ultimat3/policy';

const summarisePost = agent({
  input: t.object({ postId: t.uuid, orgId: t.uuid }),
  output: t.object({ summary: t.string }),
  prompt: definePrompt<{ postId: string }>({
    id: 'summarise-post',
    version: '1.0.0',
    template: 'Summarise post {{postId}}.',
  }),
  vars: ({ input }) => ({ postId: input.postId }),
  tools: [],
  policy: allow(),
});

export const summariseBacklog = agentJob(summarisePost, {
  name: 'summarise-backlog',
  tenant: (input) => input.orgId,
  retry: { attempts: 3, backoff: 'exponential' },
});
```

It composes `job()` rather than imitating a handle, so `.enqueue()`, the outbox, the worker's
cancellation, `x jobs show` and its manifest row all arrive for free. Pair it with `backfill()` for
the sweep and `hive()` for the fan-out inside one page.

| Rule | Why |
|---|---|
| `name` is required, and is the queue key | a job name is what queued, retrying and dead-lettered rows already carry, so renaming an export must not move where they are delivered |
| `tenant` and `retry` are required, no default | `jobs` states it: every candidate default for `tenant` is a cross-tenant read waiting for the first job that takes an org id in its input. `tenant: 'none'` is the explicit statement that it touches no scoped table |
| the action projection is read **lazily** | `agentJob()` runs at module scope beside the `agent()` it wraps, and names are stamped by `registerAction` at boot — reading `.job()` eagerly makes that ordinary file `X_ACTION_UNREGISTERED` |
| one execution path, and it is the action's | `run` is `invoke(agent, input, { surface: 'job', ctx })`, so the agent's policy, input parse, budget scope and span all apply — and the `ctx` is the worker's, so an attempt timing out aborts the agent's turn loop |
| the actor is the worker context's, never the model's | the job body runs with system authority and the org comes from the job's declared `tenant`; nothing a model emits can reach either |

### The at-least-once trap, said plainly

**`idempotencyKey` dedupes the ENQUEUE, never the ATTEMPT.** Two enqueues with the same payload are
one row. One row that a worker claims, half-runs and loses the lease on is claimed again, and **the
agent runs a second time from the top** — as does every page a `backfill()` replays, since its
`handle` is at-least-once by construction.

So every tool the agent may call has to be idempotent: an `upsertAll`, an `updateWhere`, a statement
whose second run changes nothing. Otherwise a replayed attempt issues a second refund.

**The framework does not check this, and the reason is worth knowing.** `mutates` is not a fact an
`action()` declares — it exists only in `@ultimat3/mcp`, which sets it to `true` for *every* action
it projects — so a read-only `lookupOrder` and a destructive `issueRefund` are indistinguishable
here. A rule refusing every tool that has not declared `idempotent: true` would refuse the reads
too, and a wrong refusal is worse than a stated obligation. `isMutator` is legible, but `mutator()`
is the local-first write primitive and catches almost none of the risk while reading as if it
caught all of it. This is a contract you keep, not one the compiler keeps for you.

## `describeAgents()` — what the manifest can say

```ts
import { describeAgents } from '@ultimat3/ai';

describeAgents();
// [{ name: 'supportAgent', prompt: 'support@1.0.0', promptHash: '…', model: 'claude-opus-5',
//    maxTurns: 6, maxToolResultChars: 4000, tools: ['issueRefund', 'lookupOrder'],
//    budget: { tokensIn: null, tokensPerRun: 200000, costPerCall: { minor: 50, currency: 'USD' } },
//    mcp: true }]
```

An agent projects to an `ActionDescriptor` like any other action, and that descriptor knows nothing
about turns or tools — so "how far can this loop, and what may it call" had no answer outside the
source. Names are read when you ask, not when the agent was declared: `registerAction` stamps them
at boot, long after `agent()` ran at module scope. An agent nothing registered has no row, because
an action with no name reaches no route, no tool catalogue and no queue.

## Redaction: one declared seam

`vars()` is the one place a model call loads data, so it is the one place anything can sit between
the row and a third-party endpoint.

```ts
configureAi({ gateway, redact: (text) => scrubPatientIdentifiers(text) });
```

The redactor sees the whole rendered prompt and the system prompt — template as well as values,
because a redactor shown only the values cannot tell a name in a data slot from the same name in an
instruction. Whether it changed anything is on the span as `llm.redacted`.

**What** to remove is yours: a PII classifier is a model choice, so the framework ships the seam
and not the classifier. The one rule it does enforce, redactor or not: a `Secret` among the
variables is `X_AI_PROMPT_SECRET`. Not a leak — `Secret` renders `[redacted]` by value — but a
prompt that reads fine, means something else, and costs full price.

The gateway is ambient, installed once at boot — a declaration is evaluated at module scope,
long before a provider exists:

```ts
configureAi({ gateway: createGateway({ providers: [new AnthropicProvider()] }) });
```

Missing at call time is `X_AI_GATEWAY_MISSING`, never a silent default provider.

## Evals are a test type

Not a notebook, not a weekly report — a `bun test` case that fails CI. **Every prompt has an
eval**; a `definePrompt` no `defineEval` names is `X_EVAL_MISSING` in `x verify`, because an
unevaluated prompt is untested code that costs money and answers users.

The gate is the **drop from a recorded baseline**, never an absolute score. An absolute floor
fails every eval at once the day a provider ships a slightly different model, which teaches
everyone to lower thresholds until they measure nothing.

```ts
// app/support/summarize.evals.ts — the declaration the gate reads
import { defineEval, exact, jsonSchemaValid } from '@ultimat3/ai';
import { summarize } from './prompts';

export const summarizeEval = defineEval({
  name: 'summarize',
  prompt: summarize,
  cases: [
    { name: 'refund', vars: { ticket: 'I want my money back' }, expected: 'billing' },
    { name: 'outage', vars: { ticket: 'the site is down' }, expected: 'incident' },
  ],
  scorers: [exact, jsonSchemaValid(['category', 'summary'])],
  baseline: import.meta.resolve('./summarize.baseline.json'),   // committed scores
  tolerance: 0.05,                                              // how far one may fall
});
```

```ts
// app/support/summarize.eval.test.ts — the suite `x verify` runs
test('summarize holds its recorded scores', async () => {
  await summarizeEval.assert(ai);   // throws X_EVAL_THRESHOLD on a drop past 0.05
});
```

`ULTIMATE_EVAL_RECORD=1 x test eval` writes the baselines instead of gating on them, so
accepting a new number is a reviewable diff. An eval that has never been recorded fails with
`X_EVAL_BASELINE_MISSING` — gating on nothing is not passing — and `x verify` asks that question
itself, so an eval no test happens to assert is still red.

Recording and the gate are mutually exclusive: `x verify` with `ULTIMATE_EVAL_RECORD` set is
`X_EVAL_RECORDING` and runs no suite. Recording passes by definition, and a gate that inherited
the flag would report green over numbers it had just written over the committed ones.

A failure names the score, what it fell from, the exact prompt hash, and every case that moved:

```
X_EVAL_THRESHOLD: an eval scored below its tolerance
  cause: eval "summarize" scored 0.667 against a recorded baseline of 1.000
         (tolerance 0.050) on prompt version summarize@1.0.0 (a3f1…);
         regressed: overall 0.67 ← 1.00, refund 0.00 ← 1.00
  fix:   x test eval --filter summarize to see per-case scores, then fix the prompt — or
         ULTIMATE_EVAL_RECORD=1 x test eval to accept the new numbers as a reviewed diff
```

Built-in scorers: `exact`, `contains`, `jsonValid`, `jsonSchemaValid(keys)`,
`numericTolerance(t)`, `llmJudge({ judge })` — the judge prompt is itself versioned, so a
judge that drifts is a measuring instrument that lies, and its hash is in the scorer name.

## Prompts are versioned artifacts

```ts
export const summarize = definePrompt<{ ticket: string }>({
  id: 'summarize',
  version: '1.0.0',
  system: 'You classify support tickets.',
  template: 'Classify and summarise:\n\n{{ticket}}',
  output: { type: 'object', properties: { category: { type: 'string' } } },
});
```

Content-hashed over id, version, system, template, schemas, model, effort, and thinking mode.
Edit the template without bumping the version and `definePrompt` throws — otherwise every
score ever recorded against that version is silently invalid. An unfilled `{{variable}}`
throws too, like an i18n miss.

## Retrieval

```ts
const store = new PgVectorStore({ name: 'doc_chunks', dimension: 256 });   // MemoryVectorStore in dev
await indexDocument({ store, embedder, document: { id: 'faq', text } });

const hits = await retrieve({ store, embedder, query, k: 8 });
const context = assembleContext({ hits, maxTokens: 8_000 });
context.dropped;                                              // reported, never silent
```

Retrieval is **hybrid by default** — vector + lexical, fused by reciprocal rank. Pure vector
search loses on exactly the queries users type: error codes, SKUs, identifiers, rare terms.
RRF fuses by *rank*, so the two score scales never have to be reconciled.

`PgVectorStore` is the production path: pgvector cosine (`<=>`, HNSW) and Postgres FTS
(`websearch_to_tsquery` + `ts_rank_cd`, GIN) in **the same Postgres**, fused by `1/(k+rank)` in
one statement. `MemoryVectorStore` is the dev twin — BM25 instead of `ts_rank_cd`, the same RRF,
the same envelope.

`store.ddl()` returns one string: `create extension if not exists vector`, the table, and the
three indexes (hnsw on `embedding`, GIN on `tsv`, GIN on `metadata`). **No command emits it,
`As of 2026-08`** — `x db gen <name>` diffs `describeEntities()`, a vector store is not an
`entity()`, and no CLI file references `PgVectorStore` or `ddl()` at all. Split it and paste each
statement into its own file under `packages/db/migrations/`, exactly as `AUTH_TABLES` is applied,
then `x db migrate`.

### The scope is the leak-proofing

```ts
const tenantStore = store.scoped({ tenant: orgId, allow: { visibility: ['public', 'internal'] } });
```

Every read, write and delete a scoped store emits carries `tenant = $n` and the allow-list **in
SQL** — including *both* halves of the hybrid fusion, since an unfiltered lexical ranking fused
into a filtered dense one leaks through the back door. `(tenant, id)` is the primary key, so a
cross-tenant overwrite is impossible at the storage layer rather than by remembering to check.
Allow-lists are default deny: a row missing the key is invisible, and an empty list matches
nothing. `scoped()` only ever **tightens** — re-scoping to a different tenant is
`X_VECTOR_SCOPE_WIDENED`, never a silent widening.

`chunk()` is token-aware with overlap and splits at paragraph, then sentence, then hard wrap
— a fact split across a boundary with no overlap is retrievable by neither chunk. All three
splits are load-bearing: the wrap is what bounds a UNIT (a base64 blob, a minified line, a CJK
paragraph the sentence alphabet cannot see), and a unit larger than `size` is one the size check
can never flush, so it rode every chunk after it — `As of 2026-08`, a ~1,000-token document
indexed as nine chunks of the same sentence. The overlap carries a tail forward and never the
whole buffer, for the same reason.

## Tools: the same projection as MCP

```ts
// `ProjectableAction` — `{ name, mcp?, inputJsonSchema?, run }`, the projection SEAM.
const tools = toLlmTools([publishPost, suspendUser]);   // only those with mcp.expose
const result = await runLlmToolCall(actions, call, actor);
```

An in-app agent and an external MCP agent both end at the same `invoke` — `run` is the seam that
carries it, and an action facade has no `.run` of its own. So they authorize identically. The
actor comes from the request context, never from the model.

## Errors

| Code | Meaning |
|---|---|
| `X_AI_PROVIDER_UNAVAILABLE` | every provider for the model failed; lists what each said |
| `X_AI_BUDGET_EXCEEDED` | refused pre-flight, naming the scope and what remains |
| `X_AI_GATEWAY_MISSING` | an `llm()` action ran before `configureAi` |
| `X_AI_PROMPT_VERSION` | version drift, or a render missing a declared variable |
| `X_AI_MODEL_UNKNOWN` | a model id nothing called `registerModel` for; names the registered set |
| `X_AI_PROMPT_SECRET` | `vars()` returned a `Secret`, which would render `[redacted]` into the prompt |
| `X_LLM_OUTPUT_INVALID` | the model failed its `output` schema on the answer and on the repair turn |
| `X_LLM_STREAM_INVALID` | a streamed answer failed its schema, and a stream cannot take a repair turn |
| `X_AGENT_MAX_TURNS` | an `agent()` used every turn without answering |
| `X_AGENT_TOOL_UNEXPOSED` | an `agent()` lists an action no MCP surface exposes |
| `X_EVAL_THRESHOLD` | an eval scored below its bar |
| `X_VECTOR_DIM_MISMATCH` | a vector's length disagrees with the store |
| `X_VECTOR_SCOPE_WIDENED` | a derived vector scope tried to leave the tenant it was bound to |
| `X_NOT_IMPLEMENTED` | a remote driver with no key or transport; the fix names the env var |
