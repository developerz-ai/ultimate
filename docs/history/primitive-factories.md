# Factories over primitives — why `llm()` and `backfill()` are not new kinds

Moved out of the root `CLAUDE.md` on 2026-09-23 (plan 101, slice 17 f): the rule stays in the root `CLAUDE.md`; this is the reasoning behind it.

**`llm()` is an action factory, not a ninth primitive — decided 2026-08.** A model call is a server-authoritative operation with an input schema, an output schema and a policy, which is the definition of an `action`; so `llm()` ([`packages/ai/src/llm.ts`](../../packages/ai/src/llm.ts)) *returns* one. That is what gives a model call `.tool()`, `.openapi()`, `.client()`, `.job()` and `.contract()` for free, one authz object across every surface, and a place in the manifest — none of which a ninth primitive would have inherited. The rule generalises: a new capability arrives as a **factory over an existing primitive**, never as a new kind of thing.

**`backfill()` is a job factory, decided 2026-08.** A one-pass sweep over a table is durable background work with an input schema, a retry policy, an idempotency key and a queue, which is the definition of a `job`; so `backfill()` ([`packages/jobs/src/backfill.ts`](../../packages/jobs/src/backfill.ts)) *returns* one, and inherits `.enqueue()`, the worker's cancellation, the dead-letter path, `x jobs show` and its manifest row. The pass is `inBatches()` — one statement per page — with every page in its own `step.run`, so a killed attempt resumes on the page it stopped at. What a step persists is a cursor, never the page. **`handle` is at least once**: it runs before its checkpoint lands, so an attempt cancelled between the two replays that page — the handler must be idempotent (`upsertAll`, `updateWhere`, a statement whose second run changes nothing), never `count + 1`.

**The factories are a list, never a count and never an ordinal.** `PRIMITIVE_FACTORIES` in
[`packages/core/src/registrar.ts`](../../packages/core/src/registrar.ts) is the executable set: an
exported function outside its owning package that returns an `action` or a `job` has a row there or
`scripts/primitive-factories.test.ts` fails, and a row nothing exports fails the same test. Adding a
factory is adding a row, not editing a sentence. Three file headers each called themselves "the
fourth instance" and at most one could have been right — the list is sorted by package then name, so
**no ordinal is derivable from it**, and any prose ordinal is wrong the moment the next factory
lands. `As of 2026-08-22`.
