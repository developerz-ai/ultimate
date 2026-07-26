# @ultimat3/ai 🧠

The LLM gateway primitive. Every model call in an Ultimate app goes through it, so budgets
and cost accounting cannot be bypassed by a stray `fetch`.

```ts
import { createGateway, AnthropicProvider, EchoProvider } from '@ultimat3/ai';

export const ai = createGateway({
  providers: [new AnthropicProvider({ fetch }), new EchoProvider()],
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

## Rules the gateway enforces

| Rule | Why |
|---|---|
| A budget **refuses**, never truncates | a shortened prompt yields a confidently wrong answer with no signal |
| Cost is **integer minor units** (`@ultimat3/money`) | token spend is money; the house rule has no exception |
| Cost rounds **up** | a rounded-away fraction is money the framework absorbs and a budget under-reports |
| `temperature` / `top_p` / `top_k` are never sent | rejected with a 400 on every current model — steer with the prompt |
| `effort` goes in `output_config` | a top-level `effort` is silently ignored |
| Retries use **full jitter** | synchronised retries from N workers reproduce the rate limit |
| A 4xx is never retried | the same body gets the same rejection and burns the budget |

Models, `As of 2026-07`:

| Model | Context | Max output | Input / MTok | Output / MTok |
|---|---|---|---|---|
| `claude-opus-5` (default) | 1M | 128K | $5 | $25 |
| `claude-sonnet-5` | 1M | 128K | $3 | $15 |
| `claude-haiku-4-5` | 200K | 64K | $1 | $5 |

## Evals are a test type

Not a notebook, not a weekly report — a `bun test` case that fails CI. A prompt change that
drops accuracy below its threshold breaks the build exactly like a type error does.

```ts
// app/support/summarize.eval.ts
import { defineEval, exact, jsonSchemaValid } from '@ultimat3/ai';
import { test } from 'bun:test';
import { ai } from '~/ai';
import { summarize } from './prompts';

export const summarizeEval = defineEval({
  name: 'summarize',
  prompt: summarize,
  cases: [
    { name: 'refund', vars: { ticket: 'I want my money back' }, expected: 'billing' },
    { name: 'outage', vars: { ticket: 'the site is down' }, expected: 'incident' },
  ],
  scorers: [exact, jsonSchemaValid(['category', 'summary'])],
  threshold: 0.9,
});

test('summarize holds its bar', async () => {
  await summarizeEval.assert(ai);   // throws X_EVAL_THRESHOLD below 0.9
});
```

A failure names the score, the bar, the exact prompt hash, and the three worst cases:

```
X_EVAL_THRESHOLD: eval scored below threshold
  cause: eval "summarize" scored 0.333 against a threshold of 0.900 on prompt version
         summarize@1.0.0 (a3f1…); worst cases: refund=0.00, outage=0.00, tone=0.50
  fix:   x ai eval summarize --verbose
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
const store = new MemoryVectorStore({ dimension: 256 });      // PgVectorStore in prod
await indexDocument({ store, embedder, document: { id: 'faq', text } });

const hits = await retrieve({ store, embedder, query, k: 8 });
const context = assembleContext({ hits, maxTokens: 8_000 });
context.dropped;                                              // reported, never silent
```

Retrieval is **hybrid by default** — vector + BM25 fused by reciprocal rank. Pure vector
search loses on exactly the queries users type: error codes, SKUs, identifiers, rare terms.
RRF fuses by *rank*, so the two score scales never have to be reconciled.

`chunk()` is token-aware with overlap and splits at paragraph, then sentence, then hard wrap
— a fact split across a boundary with no overlap is retrievable by neither chunk.

## Tools: the same projection as MCP

```ts
const tools = toLlmTools([publishPost, suspendUser]);   // only those with mcp.expose
const result = await runLlmToolCall(actions, call, actor);
```

An in-app agent and an external MCP agent both end at `action.run`, so they authorize
identically. The actor comes from the request context, never from the model.

## Errors

| Code | Meaning |
|---|---|
| `X_AI_PROVIDER_UNAVAILABLE` | every provider for the model failed; lists what each said |
| `X_AI_BUDGET_EXCEEDED` | refused pre-flight, naming the scope and what remains |
| `X_AI_PROMPT_VERSION` | version drift, or a render missing a declared variable |
| `X_EVAL_THRESHOLD` | an eval scored below its bar |
| `X_VECTOR_DIM_MISMATCH` | a vector's length disagrees with the store |
| `X_NOT_IMPLEMENTED` | a remote driver with no key or transport; the fix names the env var |
