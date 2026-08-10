# Error contract

`packages/core` owns `UltimateError`. **Never throw a bare `Error`** — Biome fails the build on it. Every framework error carries a stable code, a cause, and an exact fix command, and renders identically in a terminal, a browser overlay, and `--json`.

Axiom 4: errors are instructions ([`../idea/00-thesis.md`](../idea/00-thesis.md)).

## Anatomy

```ts
throw new UltimateError({
  code: 'X_DB_DRIFT',
  cause: 'table "posts" has column "publish_at" not present in any migration',
  fix: 'x db gen "add publish_at"',
  docs: 'https://ultimate.dev/errors/X_DB_DRIFT',
});
```

| Field | Required | Contents | Rule |
|---|---|---|---|
| `code` | yes | `X_` + SCREAMING_SNAKE | stable forever once shipped |
| `cause` | yes | what was observed, with the concrete identifiers | names the table, file, route, key — never "invalid input" |
| `fix` | yes | **an executable command** or a one-line edit instruction | must be runnable/pasteable as written |
| `docs` | derived | `https://ultimate.dev/errors/<code>` | generated from `code`; overridable, never hand-typed |
| `title` | derived | the registry's one-line summary for the code | so every instance of a code reads the same |
| `data` | no | structured detail: `{ route, field, chain, actual, limit }` | consumed by `--json` and by MCP tools |
| `httpStatus` | no | default 500; `X_POLICY_DENIED` → 403, `X_INPUT_INVALID` → 422 | set in the registry, not at the throw site |
| `retryable` | no | boolean | drives job retry and client backoff decisions |
| `source` | auto | package + file + stage | filled from the ALS context |

`cause` and `fix` are the two fields that decide whether an agent closes the loop unaided. An error with a vague cause and a `fix` like "check your configuration" is worse than no error — it consumes a turn and teaches nothing.

## Code registry and naming

| Rule | Detail |
|---|---|
| Prefix | `X_` always. The prefix is what makes a code greppable across logs, JSON, and prose |
| Case | SCREAMING_SNAKE, words separated by `_` |
| Shape | `X_<SUBJECT>_<CONDITION>`: `X_DB_DRIFT`, `X_JOB_STEP_FAILED`, `X_SEO_NO_TITLE` |
| Stability | **stable forever once shipped.** A code is a public API — agents match on it, docs URLs resolve to it, dashboards group by it |
| Deprecation | never rename. Add the new code, keep the old one throwing with `data.supersededBy` |
| Ownership | each package declares its own codes in `src/errors.ts` and subclasses `UltimateError` |
| Uniqueness | one code, one meaning, one package. `x verify` fails on a code declared in two packages |
| Reuse | reuse an existing code rather than minting a near-synonym; add a `rule`/`kind` field in `data` to discriminate (see `X_BOUNDARY_VIOLATION` in [`02-boundaries.md`](./02-boundaries.md)) |

## Three renderings, one source

### Terminal

```
X_DB_DRIFT: schema differs from migrations
  cause: table "posts" has column "publish_at" not present in any migration
  fix:   x db gen "add publish_at"
```

Two-space indent, aligned labels, no stack trace unless `--verbose`. The stack is noise for an error whose cause is already named.

### Browser overlay (dev)

```
┌─ X_DB_DRIFT ───────────────────────────────────────────────┐
│ schema differs from migrations                             │
│                                                            │
│ cause  table "posts" has column "publish_at" not present   │
│        in any migration                                    │
│ fix    x db gen "add publish_at"            [copy]         │
│ docs   ultimate.dev/errors/X_DB_DRIFT                      │
│ where  packages/entity/src/drift.ts:64 · stage: boot       │
└────────────────────────────────────────────────────────────┘
```

**The identical strings a terminal shows.** The overlay adds a copy button and a source link; it never rewords, summarizes, or prettifies the text. Same words in both places means an agent reading a screenshot and an agent reading stdout reach the same conclusion.

### `--json`

```json
{
  "ok": false,
  "error": {
    "code": "X_DB_DRIFT",
    "title": "schema differs from migrations",
    "cause": "table \"posts\" has column \"publish_at\" not present in any migration",
    "fix": "x db gen \"add publish_at\"",
    "docs": "https://ultimate.dev/errors/X_DB_DRIFT",
    "retryable": false,
    "source": { "package": "@ultimat3/entity", "file": "src/drift.ts", "stage": "boot" },
    "data": { "table": "posts", "column": "publish_at" }
  }
}
```

Over HTTP the same object is the problem+json body, with `httpStatus` as the status code and `type` set to `docs`. MCP tool errors carry the same object. One serializer in `core`, four consumers.

## Adding a code

| # | Step | File |
|---|---|---|
| 1 | Confirm no existing code fits (discriminate with `data` if it nearly does) | `packages/*/src/errors.ts` |
| 2 | Add the code + `title` + `httpStatus` + `retryable` to your package registry | `packages/<pkg>/src/errors.ts` |
| 3 | Write the `fix` as a command you have actually run | same |
| 4 | Add a test that asserts the code **and** that `fix` is non-empty | `packages/<pkg>/src/errors.test.ts` |
| 5 | Add the code's row to the error reference — the `errors` step requires it | `wiki/Error-Codes.md` |
| 6 | If cross-cutting, add a row to the table below | `docs/architecture/04-error-contract.md` |
| 7 | Verify: uniqueness at registration, `fix` shape and docs coverage in the `errors` step | `x verify` |

```ts
// packages/entity/src/errors.ts — one file per package, no codes declared inline
export class EntityError extends UltimateError {}

export const ENTITY_ERRORS = {
  X_DB_DRIFT: { title: 'schema differs from migrations', httpStatus: 500, retryable: false },
  X_TENANT_MISMATCH: { title: 'row tenant does not match request tenant', httpStatus: 403, retryable: false },
} as const;
```

## The `fix:` rule

**Every error carries an executable `fix:`.** Not advice — a command, or a one-line edit naming the file.

| ❌ Rejected `fix` | ✅ Accepted |
|---|---|
| `check your database connection` | `x db status --json` |
| `add a description` | `add description to meta in site/pricing/page.tsx` |
| `see the docs` | `x errors explain X_SW_UNCACHEABLE` |
| `this is not supported` | `set jobs.driver = 'pg' in app.config.ts` |
| `retry later` | `x jobs retry 8f2a1c --from nudge` |

Enforced by the **`errors` step** of `x verify`. It reads every `fix:` string literal in shipped source — test files and `.d.ts` excluded — and treats a `${…}` interpolation as unknown, so nothing inside one counts as a command.

| Fails on | Code |
|---|---|
| an empty `fix` | `X_ERROR_FIX_INVALID` |
| a `fix` carrying `check`, `make sure`, `try` or `see the docs` with no command token | `X_ERROR_FIX_INVALID` |
| a declared `X_*` code with no row in `wiki/Error-Codes.md` | `X_ERROR_CODE_UNDOCUMENTED` |

A **command token** is the `x` CLI, a known tool (`bun`, `bunx`, `git`, `docker`, `psql`, `curl`, …), a literal call expression (`name(`), or a file path (`app.config.ts`, `apps/web/api/index.ts`). "check `x doctor --json`" passes; "check your database connection" does not.

The docs half is a **host check** the framework repo contributes to the `errors` step — the same seam the tier table uses on `boundaries`.

Out of reach: a `fix` computed at runtime. `fix: input.fix` has no literal to read, so the step cannot judge it — the value's own author does.

For deliberately unimplemented paths, the throw is still typed and still actionable:

```ts
throw new UltimateError({
  code: 'X_NOT_IMPLEMENTED',
  cause: 'jobs driver "nats" has no claim implementation yet',
  fix: 'set jobs.driver = "pg" in app.config.ts',
});
```

## Cross-cutting codes

Thrown by more than one package, or by the gate about any of them; every package may reference them.

| Code | Owner | Status | Meaning | Typical `fix` |
|---|---|---|---|---|
| `X_CONFIG_INVALID` | `core` | 500 | env or `app.config.ts` failed its schema at boot | `x doctor --json` |
| `X_NO_CONTEXT` | `core` | 500 | ALS context read outside a request/job/subscription | `move this call inside a handler` |
| `X_NOT_IMPLEMENTED` | any | 501 | a labelled unimplemented driver path | switch to the default driver |
| `X_INTERNAL` | `core` | 500 | a non-`UltimateError` escaped | report with the trace id |
| `X_INPUT_INVALID` | `schema` | 422 | `input` parse failed; `data.path` names the field | fix the caller's field |
| `X_OUTPUT_INVALID` | `action` | 500 | handler returned a value the `output` schema rejects | fix the handler or the schema |
| `X_POLICY_DENIED` | `policy` | 403 | authz refused; `data.reason` is the denial reason | grant the permission or change the actor |
| `X_TENANT_MISMATCH` | `entity` | 403 | a row's tenant differs from the request tenant | scope the query to `ctx.tenantId` |
| `X_DB_DRIFT` | `entity` | 500 | schema differs from migrations | `x db gen "<name>"` |
| `X_BOUNDARY_VIOLATION` | `cli` | build | an import rule broke; `data.chain` is the path | `x fix boundary <file>` |
| `X_ERROR_FIX_INVALID` | `cli` | build | a `fix:` literal is empty, or advice with no command token | `rewrite the fix at <file>:<line> as a runnable command` |
| `X_ERROR_CODE_UNDOCUMENTED` | `cli` | build | a declared `X_*` code has no row in the error reference | `add a row for <CODE> to wiki/Error-Codes.md` |
| `X_MANIFEST_STALE` | `manifest` | build | `x.manifest.json` / `openapi.json` differ from the code | `x manifest write` |
| `X_BUDGET_EXCEEDED` | `render` | build | route bytes / LCP over budget; `data.cause` names the import | `x fix boundary <file>` |
| `X_BUILD_SKEW` | `http` | 409 | client build ID incompatible with the server contract | `reload` (client-side signal) |
| `X_RATE_LIMITED` | `http` | 429 | token bucket exhausted for `(tenant, actor, route)` | retry after `data.retryAfterMs` |
| `X_I18N_MISSING_KEY` | `i18n` | build | a key rendered as `⟦key⟧` | `x i18n add <key>` |
| `X_MONEY_CURRENCY_MISMATCH` | `money` | 500 | arithmetic across two currencies | convert explicitly first |
| `X_TIME_NO_ZONE` | `time` | build | formatting without an explicit IANA zone | pass `timeZone: ctx.tz` |
| `X_TEST_NETWORK_EGRESS` | `testing` | test | unmocked egress inside a test | mock the named URL |

Package-local codes live with their subsystem: jobs in [`08-jobs-internals.md`](./08-jobs-internals.md), realtime in [`07-realtime-internals.md`](./07-realtime-internals.md), rendering/SEO/PWA in [`09-rendering-internals.md`](./09-rendering-internals.md).
