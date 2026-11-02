# 27 — `defineEval({ agent })`, and current model ids in the examples

> Part of [`overview.md`](overview.md). Depends on: [`18-ai-scripted-and-meter.md`](18-ai-scripted-and-meter.md). Tier: 4 (`ai`), 5 (`cli`). **Returns a deferred item: `90-deferred.md` said no adopter has a scored agent baseline.** **PULLED FORWARD: the model-id edit (step 8) lands in sweep 1, before the rest: `claude-sonnet-4-5` retires 2026-11-30.**

## Why
**New evidence.** Three adopters now:
- One gates 8 agents' recorded answers through `defineEval` on a committed baseline (183 LOC of harness), and lists whole-run evals as an open gap.
- One has `defineEval` on an agent's prompt with a comment stating the limit: "an agent run needs its tools and its turns, which an eval's single request has not".
- One runs 30 eval files scoring tool selection, and a script turning flagged production steps into permanent cases.

**The defect.** `X_EVAL_MISSING` requires an eval for every prompt, agents' included. `runEval` sends the rendered prompt with **no tools** (`packages/ai/src/evals.ts:181`). So a template saying "answer through the respond tool" is measured in a request that offers none, and the score describes something the agent never runs.

## Files to change
- `packages/ai/src/evals.ts:39,132,177` — `DefineEvalInput` becomes a union over `prompt` and `agent`; the agent arm runs the loop; `promptsWithoutEvals` counts an agent's prompt as covered.
- `packages/ai/src/runtime.ts:75` — an eval-private scope naming the gateway `assert(gateway)` was handed, read by `aiGateway`.
- `packages/ai/src/tools.ts:124` — inside that scope a tool call resolves its double.
- `packages/ai/src/scorers.ts` — `calledTool(name)`; `Scorer` input gains optional `run`.
- `packages/ai/src/eval-errors.ts` — the new refusal.
- `packages/cli/src/app-evals.ts` — report rows carry the agent.
- `packages/ai/README.md`, `packages/ai/CLAUDE.md`, `docs/history/ai.md`, `wiki/Testing.md`, `wiki/Upgrading.md`.
- `examples/dummy/apps/web/app/posts/prompts/review-draft.evals.ts` — moves to the agent arm.
- Stale ids and claims: `wiki/Money.md:282`, `wiki/Caching-And-Invalidation.md:172`, `wiki/MCP-And-AI.md:337,400-405`, `docs/idea/05-caching.md:136`, `docs/idea/09-ai-first.md:88`, `wiki/Agents.md:66`, `packages/mcp/CLAUDE.md`.
- `examples/dummy/apps/web/app/models.ts:29`, its prompts and baselines.

## Steps
1. `defineEval({ name, agent, cases: [{ name, input, expected? }], tools: { [name]: (input) => unknown }, scorers, baseline, tolerance, actor?, maxTokens? })`. Same registry, baseline file, tolerance and `x verify eval` path. No `defineAgentEval`: one way to declare an eval.
2. Runs `agent.run(input, { ctx })` per case with the eval's actor (default a system actor; `actor` for a policy that needs one), under the gateway handed to `run` or `assert`. A recorded run is a `scriptedProvider` from `18`. No cassette: [`90-deferred.md`](90-deferred.md) stands.
3. `tools`: an eval **never runs a real tool**. A call to a tool with no double is `X_EVAL_TOOL_UNDOUBLED`, so an eval in CI cannot write. Doubles apply in the private scope only; no public override of `agent({ tools })`.
4. Scorers receive `output` (the answer as JSON) and `run: { turns, toolCalls, usage }`. `calledTool('x')` scores 1 or 0. Existing scorers unchanged.
5. A failed run scores 0 for that case and records the code in the report, so a loop or `X_AGENT_MAX_TURNS` is a regression and not a crash of the suite.
6. Harvesting stays out. Which production failures matter is a business detector; `cases` is plain data and `transcriptOf(error)` already hands over what happened, so an app's script writes cases.
7. Baseline key stays the prompt hash. A model change is a new prompt version, as `examples/dummy/apps/web/app/models.ts` already states.
8. **Sweep 1, its own diff.** Model ids, examples: `claude-sonnet-5-5` in the five doc sites. Two name `claude-sonnet-4-5`, which retires on 2026-11-30. Other ids where an example needs them: `claude-opus-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`.
9. Dummy: add `claude-sonnet-5-5` to `models.ts`, $2 / $10 per million, cache read $0.20, 1M window, 128K output, `forcedToolChoice: false` (it refuses a forced choice), no `sampling`. Check the cache-write price and minimum on the vendor's page in the same diff. Prompts bump (`summarize.v6`, `review-draft.v2`); old versions retained; baselines re-recorded. `bun run scripts/reference-app-gate.ts`.
10. Doc corrections: `wiki/Agents.md:66` says a closed tab does not abort a run, and `:309,313` say it does; the code joins the signal, so `:66` is wrong. `wiki/MCP-And-AI.md:400-405` documents an entity `embed:` option that no package defines: replace with what `postgresVectorStore` and `remote-embedder` do. `packages/mcp/CLAUDE.md` says 13 dev tools, the wiki 16: count and fix.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_EVAL_TOOL_UNDOUBLED` (new, off-socket) | an agent eval's model called a tool with no double | add it to `tools:` on the `defineEval`. `bun run new-error-code X_EVAL_TOOL_UNDOUBLED --package ai --title '…' --cause '…' --fix '…' --off-socket` |
| `X_EVAL_MISSING` (existing) | an agent's prompt has neither arm | existing fix, now naming the agent arm |

## Tests
- `packages/ai/src/evals-agent.test.ts` (unit, `scriptedProvider`): a two-turn case scores through `calledTool`; the request carries tools; a real tool's handler counter stays 0; an undoubled call raises the code; `X_AGENT_MAX_TURNS` scores 0 and the suite finishes; a score drop past tolerance fails `assert`.
- `packages/ai/src/eval-baseline.test.ts`: agent arm writes and reads the same file format.
- `examples/dummy/apps/web/app/posts/prompts/review-draft.eval.test.ts` (eval): the agent arm against its baseline.
- `bun test packages/ai/src/evals-agent.test.ts`

## Semver
**Breaking, one row.** The exported `DefineEvalInput` becomes a union, so reading `.prompt` off it, or `extends DefineEvalInput`, stops compiling.
Upgrading: "`DefineEvalInput` is a union over `prompt` and `agent`: narrow with `'prompt' in input` before reading it." A `defineEval` call is unchanged. The sweep 1 model-id edit is docs and dummy only: patch.

## Done when
- The dummy's review eval records a tool call in its report.
- No doc outside `docs/history/` and `CHANGELOG.md` names `claude-sonnet-4-5`.
- `bun run verify` green; `bun run scripts/reference-app-gate.ts` green.
