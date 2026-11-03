# 39 — A long tool that answers inline when it can

> Part of [`overview.md`](overview.md). Depends on: [`27-mcp-dual-era.md`](27-mcp-dual-era.md) for the wire. Tier: 4 (`mcp`), reading 3 (`jobs`).

## Why
An agent's client times out, usually in tens of seconds. A report, an import or a reindex does not fit. The killed row said `.job()` plus a query composes it, and it does, on paper. In practice each team writes the same four things: enqueue, wait a little so fast cases feel fast, a status tool, and the authorisation on that status tool, where the mistake is an id-guessing read of someone else's job. `uuidV7` ids are time-ordered, so they are not secrets.
Why it is not a second way: nothing here runs a primitive differently. The job runs through `executeJob`, the read through a query. This is a factory for a tool, the shape of `inProcessTool()`, composing two existing primitives.

## Decisions
| Question | Answer |
|---|---|
| In-process race then detach? | no: a detached promise dies on the next deploy. It enqueues from the start, so the work is durable whichever way the answer goes |
| Where the answer comes from | the app's `result` query. No result store: `x_jobs` has no result column (`driver-pg-ddl.ts`) and none is added. The body writes where the app reads, the rule `agentJob()` already states |
| The wait | polls `introspect.job(id)` (`introspection.ts:201`), 250 ms up to `inlineMs`, default 5,000, ceiling 25,000. Honours `ctx.signal`. A client that drops loses nothing |
| Running answer | `{ status: 'running', jobId, poll: { tool: 'job_status', arguments: { jobId } } }`: an agent reads a next step, not a guess |
| The status tool | one `job_status`, projected once when any job tool exists. Answers `running`, `done` plus the `result` query's output, `failed` plus code and `callerFix` only |
| Who may read | caller's actor id equals `JobRecord.enqueuedBy` (`driver.ts:122`), and org equal. Anything else answers the same not-found as an unknown id. "`enqueuedBy` is attribution, never authority" (`jobs/CLAUDE.md`) concerns what a body may do; this is a read of a row about the caller's own request, and the `result` query still runs its own policy |
| Dedupe | `idempotencyKey` from the tool's reserved argument, as `tool-idempotency.ts`; a repeated call attaches to the live run via `deduped` |
| Driver without `introspect` | refused at load: a long tool that cannot report is not one |
| The tasks extension | not shipped, per [`27-mcp-dual-era.md`](27-mcp-dual-era.md) step 11. This answer is plain tool output on both eras. If the extension lands, this factory is where it maps |
| Policy | required on the factory, enforced by the same gate; scopes map and confirmations wrap it like any tool |

## Files to change
- `packages/mcp/src/job-tool.ts` (new) — `jobTool({ job, policy, description, input?, result, inlineMs? })`.
- `packages/mcp/src/job-status-tool.ts` (new) — the read, its gate.
- `packages/mcp/src/app-tools.ts:229,282` — accepts them in `tools:`; projects `job_status` once; load refusals. `packages/mcp/src/errors.ts`, `index.ts`.
- `packages/mcp/src/scopes.ts` — `job_status` exempt, as `whoami`: gated per row instead.
- `examples/dummy/packages/mcp/` — one job tool. `wiki/MCP-And-AI.md`, `wiki/Error-Codes.md`, `packages/mcp/{README,CLAUDE}.md`. `90-deferred.md`'s row via the coordinator. `packages/ai/src/tools.ts` unchanged: in-app agents have `agentJob()`, and the parity test covers action projections, which this is not.

## Steps
1. `bun run new-error-code` below.
2. Factory returns the same hand-written tool shape `handWritten` accepts (`app-tools.ts:282`), carrying a private brand so `job_status` is projected.
3. `handle`: enqueue under the caller, wait, then run `result` through `invoke`-equivalent query path as the caller on `done`, and render `failed` through `discloseFailure`'s rule (`hasPublicCause`), not raw `last_error`.
4. A job ending `dead` or `failed`: `status: 'failed'` with the row's code. A row's text is the worker's; only the code and a declared `callerFix` cross.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_MCP_JOB_TOOL_INVALID` (off-socket) | no `introspect` on the driver, a `job` that is not a handle, `inlineMs` beyond the ceiling | use the Postgres or memory driver; pass `job()`'s handle; lower `inlineMs`. `bun run new-error-code X_MCP_JOB_TOOL_INVALID --package mcp --title '…' --cause '…' --fix '…' --off-socket` |

## Tests
- `packages/mcp/src/job-tool.test.ts` (unit, memory driver, `runJobs`, frozen clock): fast job answers inline with the query's output; slow answers running, then `job_status` reaches `done`; a repeated key attaches.
- `packages/mcp/src/job-status-security.test.ts`: another actor, another org and an unknown id each get byte-equal not-found; a failed job's `last_error` text never appears; a scope-denied `result` query is that denial.
- `packages/mcp/src/job-tool-drain.test.ts`: `ctx.signal` abort during the wait leaves the job running.
- `examples/dummy` contract over `mcp-drive`. `bun test packages/mcp/src/job-tool.test.ts`

## Semver
Minor. New export. `job_status` appears only on a server declaring a job tool; an app tool already named that collides at load through `assertUniqueNames`.

## Done when
- A job tool taking longer than `inlineMs` never hits a client timeout, and its result is reachable with one more call.
- Reading another caller's job is indistinguishable from an unknown id.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green.
