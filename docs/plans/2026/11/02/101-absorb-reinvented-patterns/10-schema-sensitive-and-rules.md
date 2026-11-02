# 10 — Schema facts the framework already wants: `.sensitive()` and an issue's `rule`

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0 (`schema`), 2 (`entity`, `http`), 3 (`action`, `query`, `jobs`), 4 (`ui`).

## Why
**Sensitive.** Redaction asks one global table by key name (`packages/core/src/logger.ts:153`). Probe: `isRedactedKey` is false for `cardPan`, `ssn`, `cardNumber`, `iban`, and `redactInput` and `auditableInput` both print `{"cardPan":"4111111111111111","ssn":"078-05-1120",…}`. `redactKeys` is the wrong home for a schema fact: `idempotency-redact.ts:133` reads the same table, so marking `note` in action A would change what keyed action B stores. So the schema says it, and walkers that hold that schema read it.
**Rule.** A form's translator gets English. Probe: `t.string.min(3)` on `''` gives `{ path, expected: <the message>, received: '', message: 'expected a non-empty string of at least 3 chars…' }`. `issuesFromValidation` sets `code: undefined` (`packages/ui/src/form/form-issue.ts:61`). `messageFor` can only key on framework English, which changes without a semver signal.
**Entity bounds, the surviving part.** `posts.$input.pick()` is killed: `$view` already is it. Probe: `input: posts.$view(['title'])` publishes `maxLength: 200` and refuses 300 characters. Its one defect: the issue has `path: ''` and wraps a whole `EntityError` line, so a form cannot bind it. The hand-bound alternative (`t.string.max(500)` over `text({ max: 200 })`) answers a coded 422 `X_INVARIANT_VIOLATED`, also unbound.

## Files to change
- `packages/schema/src/node.ts:49` — `sensitive?: boolean` on `SchemaNode`.
- `packages/schema/src/sensitive.ts` (new) — `maskSensitive(schema, value, replacement)`, `assertNoSensitiveOutput(owner, schema)`. Its own file, so `t` does not carry it.
- `packages/schema/src/builder.ts:100,242` — `.sensitive()` next to `.describe()`.
- `packages/schema/src/json-schema.ts:185` — `writeOnly: true` in `annotations`.
- `packages/action/src/invoke.ts:240,271`, `packages/query/src/read.ts:315,333` — mask `trace.input`, read only for the audit record.
- `packages/jobs/src/inspect.ts:149,163` — mask with the `handle` already looked up, before `redactInput`.
- `packages/action/src/registry.ts:59`, `packages/query/src/registry.ts:31` — the output check.
- `packages/schema/src/builder.ts:45`, `validators.ts`, `array-schema.ts`, `discriminated-union.ts`, `money-value.ts`, `json-value.ts` — internal `rejected` takes a rule.
- `packages/schema/src/errors.ts:155`, `packages/schema/src/standard.ts` — `rule`, `params` on the issue.
- `packages/http/src/error-facts.ts:190-201` (explicit field copy), `packages/action/src/wire-issues.ts:23`, `packages/action/src/openapi.ts` `PROBLEM_SCHEMA` — carry both over the wire.
- `packages/ui/src/form/form-issue.ts:20,61,109` — `FormIssue.rule`, `FormIssue.params`.
- `packages/entity/src/view.ts:125-150` — issues per key.
- `packages/ui/README.md:653-658` — stale "the wire carries no structured issue list"; `error-facts.ts:172` serves one. Rewrite.
- `packages/schema/README.md`, `packages/entity/README.md`, `wiki/Actions.md` `## Fields`, `wiki/UI-Components.md`, `wiki/I18n.md`.
- `examples/dummy/` — one `.sensitive()` input field, one `messageFor` keyed on `rule`, one `$view` input; `x.manifest.json` for the budget raise.

## Steps
1. `.sensitive()` means "sent in, never written down by the framework, never sent back": JSON Schema's `writeOnly`. Does not touch `redactKeys`.
2. `maskSensitive` walks the node beside the value: `properties`, `items`, `valueNode`, and for `anyOf` any branch's flagged key (fail closed, no branch resolution). Answers the same reference when the node has no flag, memoised per node, so an unflagged action pays one map read.
3. Reach, stated plainly: the audit record for actions and queries, and `x jobs show`. An app's own `logger.info('x', input)` carries no schema and is not covered: that stays `redactKeys`, or a `Secret`. Document this; do not claim logs.
4. `inspect.ts` with no `handle` (the job's declaration is gone): `input` answers `[redacted]` whole, since nothing can say which keys are sensitive.
5. A sensitive field reachable from an action's `output` or a query's `rows` (`packages/query/src/query.ts:102`) is a declaration error: an output leaves the server, contradicting `writeOnly`. Code and check live in `schema`, because `query` cannot import `action`. PII read back and only hidden in logs stays `redactKeys(['ssn'])`.
6. Package-internal `rejected(path, message, rule, params?)`, used by every builtin validator: a required parameter is the enforcement, so a builtin call site without a rule is a type error. Exported `fail` (`packages/schema/src/index.ts:19`) gains `rule?` and `params?` as optional, because providers call it.
7. Closed vocabulary `SCHEMA_RULES`: `required`, `type`, `string.min`, `string.max`, `string.pattern`, `string.format`, `number.min`, `number.max`, `number.integer`, `enum`, `literal`, `array.min`, `array.max`, `union`, `record.key`, `json`, `money`, `refine`. A refinement carries `params: { name }` (`node.ts:43`). `rule` is optional on the issue type: a third-party provider has none, and `messageFor` falls back as today. Values are contract, like `X_*` codes: add, never rename.
8. **Bytes (axiom 9).** `t` is in every bundle graph. Measured on a copy of `packages/schema/src` with a rule literal at every `fail` site in the five validator files plus `builder.ts`: `t`-only browser chunk, `--minify`, 18,847 B → 19,236 B, **+389 B**, gzip +36 B. Re-measure on the real diff, raise each route budget by the measured figure with this reason (`bun run budget-raises`, `X_BUDGET_RAISE_UNSTATED`), and regenerate `examples/dummy/x.manifest.json`, then `x verify --only manifest,budgets` there.
9. `viewFor`'s validator: a per-key failure becomes an issue with `path: [key]`, a rule from the column fact, and the column's own sentence. `$parse` still throws as before.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_SCHEMA_SENSITIVE_OUTPUT` (new, off-socket) | `.sensitive()` reachable from an action's `output` or a query's `rows` | `remove .sensitive() from <path>, or drop the field from the output, then x verify`. `bun run new-error-code X_SCHEMA_SENSITIVE_OUTPUT --package schema --title '…' --cause '…' --fix '…' --off-socket` |

## Tests
- `packages/schema/src/sensitive.test.ts` (unit): the flag survives `.optional()`, `.nullable()`, `t.array`, `t.record`, unions; `writeOnly` published; an unflagged schema returns the same reference; each nesting masks.
- `packages/action/src/audit.test.ts` (unit): `{ cardPan: t.string.sensitive() }` on action A reaches the sink as `[redacted]`. Keyed action B with its own `cardPan` stores what it stored before, and a `note` output stays readable. Both fail on a global-table design.
- `packages/query/src/audit-gate.test.ts`, `packages/jobs/src/inspect.test.ts` (unit): same; a job with no handle answers `[redacted]`.
- `packages/action/src/registry.test.ts`, `packages/query/src/registry.test.ts` (unit): the output refusal.
- `packages/entity/src/view.test.ts` (unit): `$view(['title'])` as input gives `issues[0].path === 'title'` through `invoke`.
- `packages/schema/src/validators.test.ts` (unit): a table of every rule with `rule` and `params`; a snapshot of `SCHEMA_RULES`.
- `packages/action/src/openapi-problem.test.ts`, `packages/http/src/error-facts.test.ts`, `packages/action/src/wire-issues.test.ts`: `rule` round-trips; a non-string one is dropped.
- `packages/ui/src/form/form-issue.test.ts`: local and server issues give the same `rule`.
- `bun test packages/schema/src/sensitive.test.ts`

## Semver
Minor. Issue fields, `FormIssue.rule` and `FormIssue.params` are optional members; exported `fail` gains optional parameters; `writeOnly` appears only on schemas using `.sensitive()`. One behaviour change: `x jobs show` hides the input of a job whose declaration is gone. Upgrading row for that.

## Done when
- `{ cardPan: t.string.sensitive() }` is `[redacted]` in an audit row and `x jobs show`, with no other call and no effect on any other action.
- A translator can write `messageFor: (i) => t(\`form.${i.rule}\`, i.params)` for every builtin rule.
- `$view` input binds its refusal to the field.
- Budgets raised by the measured figure; `bun run verify` and the app gate green.
