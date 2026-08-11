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

Models, `As of 2026-08`:

| Model | Context | Max output | Input / MTok | Output / MTok | `effort` | adaptive thinking |
|---|---|---|---|---|---|---|
| `claude-opus-5` (default) | 1M | 128K | $5 | $25 | yes | yes, off only at `effort ≤ high` |
| `claude-sonnet-5` | 1M | 128K | $3 | $15 | yes | yes |
| `claude-haiku-4-5` | 200K | 64K | $1 | $5 | no — a 400 | no — a 400 |

The last two columns are data on the spec, not prose: `body()` builds the reasoning half from
them, so a downgrade for price cannot become a request the provider rejects.

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
| `vars` | the one declared place a model call loads data, so a reader can see what was sent |

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
  fix:   x test summarize to see per-case scores, then fix the prompt — or
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
the same envelope. `store.ddl()` prints the table and both indexes; `x db gen` emits it.

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
| `X_AI_GATEWAY_MISSING` | an `llm()` action ran before `configureAi` |
| `X_AI_PROMPT_VERSION` | version drift, or a render missing a declared variable |
| `X_LLM_OUTPUT_INVALID` | the model failed its `output` schema on the answer and on the repair turn |
| `X_EVAL_THRESHOLD` | an eval scored below its bar |
| `X_VECTOR_DIM_MISMATCH` | a vector's length disagrees with the store |
| `X_VECTOR_SCOPE_WIDENED` | a derived vector scope tried to leave the tenant it was bound to |
| `X_NOT_IMPLEMENTED` | a remote driver with no key or transport; the fix names the env var |
