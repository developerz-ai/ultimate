# Agents

`agent()` is an **action factory**, not a ninth primitive. A tool-using run is one server-authoritative operation with an input schema, an output schema and a policy — the definition of an `action` — so `agent()` returns one, and inherits `.tool()`, `.openapi()`, `.client()`, `.job()`, `.contract()` and its manifest row without a line of agent-specific code.

`As of 2026-08`. Source: [`packages/ai/src/agent.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/ai/src/agent.ts). The gateway, prompts, evals and the MCP surface are [MCP and AI](MCP-And-AI); the primitive vocabulary is [The eight primitives](The-Eight-Primitives).

## Quick answers

| Question | Answer |
|---|---|
| How do I make one agent call another agent? | List it in the caller's `tools`. An agent **is** an action, so it needs nothing else → [An agent is a tool of another agent](#an-agent-is-a-tool-of-another-agent) |
| How do I cancel an agent run when the user closes the tab? | `ctx.signal`. Over HTTP that signal is the **request deadline**, not the socket — a closed tab does not abort it `As of 2026-08` → [Cancellation](#cancellation) |
| How do I run an agent over 2 million rows without blowing my budget? | `backfill()` for the sweep, `hive()` or `agentJob()` per page, `budget.tokensPerRun` on both, and a shared `BudgetStore` for the fleet-wide ceiling → [Millions of rows](#millions-of-rows) |
| Do agent tool calls run in parallel? | Yes — every tool of **one turn**, concurrently and unbounded. Turns themselves are serial → [Tools of one turn run concurrently](#tools-of-one-turn-run-concurrently) |
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
  model: 'claude-sonnet-5',
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
| `model` | no | the prompt's `model`, else `claude-opus-5` | |
| `maxTurns` | no | **8** | reaching it is `X_AGENT_MAX_TURNS`, never a partial answer |
| `maxTokens` | no | **4,096** | completion ceiling **per turn**. The model never sees it |
| `maxToolResultChars` | no | **4,000** | one tool result's ceiling; truncation says so in the transcript |
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
| A repair turn hit its `maxTokens` | `X_LLM_TRUNCATED` |
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
| Budget under parallelism | still holds — every call queues on the ledger's root turnstile, which debits before the provider is reached |

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
| `actor` / `org` | tokens across a whole window, per identity | `createGateway({ budget })` |

A budget **refuses**; it never truncates. A shortened prompt yields a confidently wrong answer with no signal, and `X_AI_BUDGET_EXCEEDED` names the scope and what remains.

**Why the ceiling holds when members run in parallel.** Two mechanisms, both in [`packages/ai/src/budget.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/ai/src/budget.ts):

| Mechanism | What it fixes |
|---|---|
| `reserve()` **debits** the pre-flight estimate, it does not merely check it | three concurrent calls under one ledger otherwise all read `spent() === 0`, all pass, and all three record against a ceiling only one of them fitted. `record()` then replaces the estimate with the provider's real counts, and `release()` gives it back when the call never happened |
| Reservations queue on the **root** ledger's turnstile, not on their own | `derive()` gives every call its own ledger, so a per-ledger queue serialises nothing: `Promise.all` of three derived ledgers all read the chain before any of them debits it. The turnstile is the root's, so reservations under one scope take turns however deep the derivation goes. A refusal is chained on a settled shadow, so one refusal does not reject everything queued behind it |
| `derive()` takes the **tighter** of each limit and never the looser | a per-call budget on an inner `agent()` must not be able to widen the actor or org ceiling it runs inside |
| `reserveNow()` walks the **whole** parent chain | each ledger keeps its own counter, and the tightest limit is not always the one with the most spent against it |

One event loop, so a promise chain is the lock. A `BudgetStore` shared across **processes** needs an atomic increment of its own — this closes the parallelism inside one process. The default `MemoryBudgetStore` is per process and resets on every deploy: `org: 20_000_000` at six replicas is six ledgers of twenty million.

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

## Progress (`onTurn`)

A 90-second agent run emits nothing until it returns. `onTurn` is what a progress indicator, a per-turn spend line and a transcript log read.

```ts
onTurn: ({ turn, maxTurns, model, toolCalls, stopReason, usage, cost }) => {
  // turn is 1-based, so `turn === maxTurns` is the last one this run will take
  // toolCalls are names, in the order the model emitted them — `respond` is not one
  // cost is THIS turn's alone, never the run's running total
},
```

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

It composes `job()` rather than imitating a handle, so `.enqueue()`, the outbox, the worker's cancellation, the dead-letter path, `x jobs show` and its manifest row all arrive for free. One execution path, and it is the action's: `invoke(agent, input, { surface: 'job', ctx })`, so the agent's policy, input parse, budget scope and span all apply — and `ctx` is the **worker's**, so an attempt timing out aborts the turn loop.

### The at-least-once trap

> **Rule you must satisfy: every tool an `agentJob` may call is replay-safe. The framework does not and cannot check this.**

**`idempotencyKey` dedupes the ENQUEUE, never the ATTEMPT.**

Two `enqueue` calls with the same payload are one row. One row that a worker claims, half-runs and loses the lease on is claimed again — and **the agent runs a second time from the top**. Every turn re-executes. Every tool call re-executes.

So **every tool an agent may call has to be idempotent**: an `upsertAll`, an `updateWhere`, a statement whose second run changes nothing. Otherwise a replayed attempt issues a second refund against the same order.

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
| per actor, per org, **fleet-wide** | `createGateway({ budget: { actor, org }, budgetStore })`. The default `MemoryBudgetStore` is per process; a shared store is what makes these mean anything above one replica |
| rows per second | `backfill`'s `rate` and `batch`. This pass shares its pool with the requests the app is still serving |
| which deploys sweep at all | `backfill`'s `environments`. A mismatch is `X_BACKFILL_ENVIRONMENT`, refused inside the pass as well as by the CLI |

`x db backfill --pending` lists declared sweeps the ledger has never completed; `x db backfill <name> --write` enqueues one. Full detail: [Migrations and backfills](Migrations-And-Backfills).

## `describeAgents()`

```ts
import { describeAgents } from '@ultimat3/ai';

describeAgents();
// [{ name: 'supportAgent', prompt: 'support@1.0.0', promptId: 'support', promptHash: '…',
//    model: 'claude-sonnet-5', maxTurns: 6, maxToolResultChars: 4000,
//    tools: ['issueRefund', 'lookupOrder'],
//    budget: { tokensIn: null, tokensPerRun: 200000, costPerCall: { minor: 50, currency: 'USD' } },
//    mcp: true }]
```

An agent projects to an `ActionDescriptor` like every other action, and that descriptor knows nothing about turns or tools — so "how far can this loop, and what may it call" had no answer outside the source. `tools` is the agent's **blast radius**, sorted. `promptHash` is there because an agent's behaviour is its prompt: a row without one records which agent ran and not which agent it *was*.

Names are read when you ask, not when the agent was declared: `registerAction` stamps them at boot, long after `agent()` ran at module scope. An agent nothing registered has **no row**, and that is not a silent drop — an action with no name reaches no route, no tool catalogue and no queue, so there is no capability for a row to describe. Register it: `registerAction('supportAgent', support)`.

## No semantic cache

`llm()` has one. `agent()` deliberately does not.

Similar prompts do not have similar answers once the answer depends on what `lookupOrder` returned this second, and a cache over that would serve one run's world state to another. A prompt version bump plus the tools' own caching is the story. The gateway's exact-match response cache still applies per model call, and a **refusal is never cached** — a cached one keeps serving a classifier decision after the prompt was fixed.

## Errors

| Code | Cause | Fix |
|---|---|---|
| `X_AGENT_TOOL_UNEXPOSED` | a `tools` entry declares no `mcp` block, or `mcp: { expose: false }`. Raised at **declaration** | add `mcp: { expose: true, description }` to the action `cause` names, or drop it from `tools` |
| `X_AGENT_MAX_TURNS` | the loop used every turn calling tools and never answered | tell the template when to stop and answer through the respond tool, then bump its version |
| `X_LLM_OUTPUT_INVALID` | every turn's answer failed the `output` schema | describe the shape in the template and bump its version, or widen `output` |
| `X_LLM_REFUSED` | the provider's classifiers declined; `stopDetails.category` names why | set `model:` to the more capable one the thrown `fix:` names, or edit the template and bump its version |
| `X_LLM_TRUNCATED` | a turn hit `maxTokens` before finishing | raise `maxTokens:` on the declaration, or drop fields from `output` |
| `X_HIVE_EMPTY` | `split()` produced zero members | return at least one member input, or guard the call site |
| `X_AI_BUDGET_EXCEEDED` | refused pre-flight, naming the scope and what remains | raise that scope's ceiling, or shorten the prompt |
| `X_AI_PROMPT_SECRET` | `vars()` returned a `Secret` | drop the key from `vars()` and the template, or `revealSecret(value)` if the model genuinely has to read it |
| `X_AI_GATEWAY_MISSING` | the agent ran before `configureAi` | `configureAi({ gateway: createGateway({ providers: [new AnthropicProvider()] }) })` at boot |
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
- A hive reports in split order with three member arms; an empty split is an error.
- `idempotencyKey` dedupes the enqueue, never the attempt — every tool an agent may call must be idempotent, and nothing checks it for you.

Source: [`packages/ai/src`](https://github.com/developerz-ai/ultimate/blob/main/packages/ai/src)
