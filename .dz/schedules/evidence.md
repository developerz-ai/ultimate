# Brief: what does production say about the framework this week?

Weekly checkup fired by `schedules: evidence` in `.dz/maintainer/maintainer.yml`. It reads what
the deployed apps recorded and turns every **framework-attributable** failure into one issue an
agent can reproduce. An app's own bug is not this repository's.

## Where the evidence is

Every read below goes through the operator's infrastructure, read-only, never through this
repository, and never with an owner's personal credential (plan 101b slice 30, I1–I4 and I10:
`docs/plans/2026/11/14/101-finished-and-self-maintained/30-infra.md`). `As of 2026-11-15` those
read paths are being built: a source this run cannot read is recorded as `unreadable: <source>`
in the run summary, never guessed at and never a finding.

| Source | Read | Framework-attributable when |
|---|---|---|
| the error tracker's open issues for each deployed app | issues from the last 7 days | the issue carries a framework `X_*` code (`bun run x -- errors explain <code> --json` answers for it), or its top in-app frame is under `node_modules/@ultimat3/` |
| slow statements | the database's statement statistics, top by total time | the statement is one the framework writes: a framework table (`x_jobs`, `x_failures`, `x_api_keys`, …) or a query shape `packages/entity/src/pg-driver.ts` builds |
| dead jobs | counts by job, state and error code — no payloads | dead with a framework code, or a framework job (`purge`, `backfill`, a `cronJob`) dead at all |
| firing alerts | the chart's alerts (`docker/helm/templates/alert-rules.yaml`) firing in the week | each fire: its runbook in `docs/ops/06-runbooks.md` names a framework mechanism |

Never copy a row, a payload, a user's input, a hostname, a tenant or an app's name into an issue.

## What to file

One issue per distinct framework failure, unless an open issue already names its code and frame:
`gh issue list --state open --search '<X_CODE> in:body' --json number,title,url`. Title:
`evidence: <X_CODE or symptom> in <package>`. The body is the `x repro --bundle` shape
(`wiki/CLI-Reference.md` § x repro), filled from what was read:

| Section | Holds |
|---|---|
| `framework` | the `@ultimat3/*` version the app runs, Bun's version |
| `error` | the code, the cause, the stack's `at …` frames under `@ultimat3/*` |
| `count` | occurrences in the week, first and last seen |
| `subject` | the failing call's shape — primitive, name, the input's field names, never its values |
| `reproducer` | a failing test against `examples/dummy` when one could be written this run, else `none yet` |

A slow framework statement files with its plan (`EXPLAIN`, no literals) and its mean and total time.

Each issue is input to next month's `.dz/schedules/audit.md`. Nothing framework-attributable: end the
run summary with `evidence <YYYY-MM-DD>: nothing found — <sources read>, <sources unreadable>`.

If the maintainer's own model or key fails mid-run:
`docs/ops/maintainer-runbooks/model-or-key-retired.md`.

## Rows

- `sources` — Read each source through the infrastructure's read-only path; record an unreadable one as `unreadable: <source>`, never a finding.
- `attribute` — Keep only failures carrying a framework `X_*` code, a framework frame, a framework statement, a framework job or a framework alert.
- `dedupe` — File nothing for a failure an open issue already names by code and frame.
- `file` — One issue per failure, in the `x repro --bundle` shape, with no row, payload, host, tenant or app name.
