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
| `httpStatus` | no | default 500; `X_FORBIDDEN` → 403, `X_INPUT_INVALID` → 422 | set in the registry, not at the throw site |
| `retryable` | no | boolean | drives job retry and client backoff decisions |
| `source` | auto | package + file + stage | filled from the ALS context |

`cause` and `fix` are the two fields that decide whether an agent closes the loop unaided. An error with a vague cause and a `fix` like "check your configuration" is worse than no error — it consumes a turn and teaches nothing.

## Code registry and naming

| Rule | Detail |
|---|---|
| Prefix | `X_` always. The prefix is what makes a code greppable across logs, JSON, and prose |
| Case | SCREAMING_SNAKE, words separated by `_` |
| Shape | `X_<SUBJECT>_<CONDITION>`: `X_DB_DRIFT`, `X_JOB_MAX_ATTEMPTS`, `X_ROUTE_META_MISSING` |
| Stability | **stable forever once shipped.** A code is a public API — agents match on it, docs URLs resolve to it, dashboards group by it |
| Deprecation | never rename. Add the new code, keep the old one throwing with `data.supersededBy` |
| Ownership | each package declares its own codes in `src/errors.ts` and subclasses `UltimateError` |
| Borrowing | a package that throws another's code names it in `<PKG>_BORROWED_ERROR_CODES` and titles it nowhere. That line is the machine-readable half: it is how `framework.manifest.json` attributes `X_NOT_IMPLEMENTED` to `core` and not to the eleven packages that throw it |
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
import { registerErrorCodes, UltimateError } from '@ultimat3/core';

/** Codes this package declares and owns. Borrowed codes go in a second list, never titled twice. */
export const ENTITY_OWNED_ERROR_CODES = ['X_INVARIANT_VIOLATED', 'X_TENANCY_UNSCOPED'] as const;

export type EntityOwnedErrorCode = (typeof ENTITY_OWNED_ERROR_CODES)[number];

export const ENTITY_ERROR_TITLES: Readonly<Record<EntityOwnedErrorCode, string>> = {
  X_INVARIANT_VIOLATED: 'a domain invariant rejected this row',
  X_TENANCY_UNSCOPED: 'a tenant-scoped query has no org predicate',
};

// Registration is the import's side effect: `format()` renders the title, and a second package
// claiming one of these fails as X_ERROR_CODE_DUPLICATE rather than silently winning the race.
registerErrorCodes(
  Object.fromEntries(Object.entries(ENTITY_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

export class EntityError extends UltimateError {}
```

The status is **not** declared here. `ERROR_STATUS` in `@ultimat3/http` is the one place a code
becomes a status, for the reason the next section gives.

## Code → HTTP status

`ERROR_STATUS` in [`packages/http/src/error-map.ts`](../../packages/http/src/error-map.ts) is the
one place a code becomes a status. It is closed, and it holds the **framework's** codes — every
package's, because HTTP is the only layer that knows what a status means, so no other package ever
hardcodes one.

An app's own codes are not in it, and `statusFor` falls back to 500. Left there, every
app-defined code answered 500 — and the `error-map` stage reports `status >= 500` to the error
monitor, so a wrong password paged whoever was on call. An app declares its half:

```ts
// beside the module that declares the codes — importing it IS the registration
registerErrorStatus({ X_CREDENTIALS_INVALID: 401, X_SIGNUP_CLOSED: 403 });
```

| Rule | Why |
|---|---|
| the framework table wins, and registering a code it already holds is `X_ERROR_STATUS_INVALID` | an app that could map `X_UNAUTHENTICATED` to 200 changes a contract every client depends on |
| a status outside 100–599 is `X_ERROR_STATUS_INVALID` | a status the runtime cannot send is a 500 with extra steps |
| re-registering one code with a **different** status is `X_ERROR_STATUS_INVALID`; the same status is a no-op | a re-import is not a bug; two answers for one code is |
| an undeclared code is still 500 | a missing row is a loud fault, never a quiet 200 |

The status decides the paging, not only the response: 4xx is the caller's mistake, the problem
document already told them, and a monitor holding those is a log nobody reads. An app that wants
to be paged declares a 5xx and gets one.

## The `fix:` rule

**Every error carries an executable `fix:`.** Not advice — a command, or a one-line edit naming the file.

| ❌ Rejected `fix` | ✅ Accepted |
|---|---|
| `check your database connection` | `x doctor --json` |
| `add a description` | `add description to meta in site/pricing/page.tsx` |
| `see the docs` | `x errors explain X_SW_SCOPE_INVALID` |
| `this is not supported` | `set jobs.driver = 'pg' in app.config.ts` |
| `retry later` | `x jobs retry 8f2a1c --from-step nudge` |

Enforced by the **`errors` step** of `x verify`. It reads every `fix:` string literal in shipped source — test files and `.d.ts` excluded — and treats a `${…}` interpolation as unknown, so nothing inside one counts as a command.

| Fails on | Code |
|---|---|
| an empty `fix` | `X_ERROR_FIX_INVALID` |
| a `fix` carrying `check`, `make sure`, `try` or `see the docs` with no command token | `X_ERROR_FIX_INVALID` |
| a `fix` citing an `x <command>` the registry does not hold, or one that is **planned** | `X_ERROR_FIX_INVALID` |
| a declared `X_*` code with no row in `wiki/Error-Codes.md` | `X_ERROR_CODE_UNDOCUMENTED` |

A **command token** is the `x` CLI, a known tool (`bun`, `bunx`, `git`, `docker`, `psql`, `curl`, …), a literal call expression (`name(`), or a file path (`app.config.ts`, `apps/web/api/index.ts`). "check `x doctor --json`" passes; "check your database connection" does not.

The citation rule is **conditional, and that is load-bearing**: *if* a `fix` names `x <command>`, `citationProblem` (`packages/cli/src/fix-command.ts`) resolves it against the registry — the same one `x help` prints — and a second word is judged as a subcommand only when the spec declares subcommands. A `fix` that names no command at all is fine when it is executable on its own (`set OTEL_EXPORTER_OTLP_ENDPOINT=…`). A **planned** command fails the rule: `x logs tail` parses and `x help` lists it, and running it hands the reader `X_NOT_IMPLEMENTED` instead of the fix.

The docs half is a **host check** the framework repo contributes to the `errors` step — the same seam the tier table uses on `boundaries`.

"Which codes exist?" has one implementation, `collectDeclaredCodes` in `packages/cli/src/error-contract.ts`: one walk of every shipped source file, one entry per code, the owning registry preferred over any throw site and over any registry that borrowed it. The docs check reads it, and so does `framework.manifest.json` — a second scanner over a narrower file set is how the manifest came to omit 26 codes and misattribute a 27th.

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
| `X_NO_REQUEST` | `http` | 500 | a request-scoped reader (`useRequestCookie`, `setRedirect`) used inside a job or a task | read it in a handler; a job takes the value from its payload |
| `X_ERROR_STATUS_INVALID` | `http` | 500 | `registerErrorStatus()` given a framework code, an out-of-range status, or a second answer for one code | map a code this app owns to a status the framework does not hold |
| `X_NOT_IMPLEMENTED` | any | 501 | a labelled unimplemented driver path | switch to the default driver |
| `X_INTERNAL` | `core` | 500 | a non-`UltimateError` escaped | report with the trace id |
| `X_INPUT_INVALID` | `action` | 400 | `input` parse failed; `data.path` names the field | fix the caller's field |
| `X_OUTPUT_INVALID` | `action` | 500 | handler returned a value the `output` schema rejects | fix the handler or the schema |
| `X_FORBIDDEN` | `policy` | 403 | authz refused; `data.reason` is the denial reason | grant the permission or change the actor |
| `X_TENANCY_ACTOR_MISMATCH` | `entity` | 403 | a predicate or a row names a tenant that is not the actor's | scope the read to `ctx.actor.orgId` |
| `X_TENANCY_CROSS_DENIED` | `entity` | 403 | `crossTenant()` refused: the actor's scopes do not carry the capability | grant the cross-tenant scope, or drop the `crossTenant()` |
| `X_DB_DRIFT` | `entity` | 500 | schema differs from migrations | `x db gen "<name>"` |
| `X_BOUNDARY_VIOLATION` | `cli` | build | an import rule broke; `data.chain` is the path | `x fix boundary <file>` |
| `X_ERROR_FIX_INVALID` | `cli` | build | a `fix:` literal is empty, or advice with no command token | `rewrite the fix at <file>:<line> as a runnable command` |
| `X_ERROR_CODE_UNDOCUMENTED` | `cli` | build | a declared `X_*` code has no row in the error reference | `add a row for <CODE> to wiki/Error-Codes.md` |
| `X_MANIFEST_STALE` | `manifest` | build | `x.manifest.json` / `openapi.json` differ from the code | `x manifest` |
| `X_BUDGET_EXCEEDED` | `render` | build | route bytes / LCP over budget; `data.cause` names the import | `x fix boundary <file>` |
| `X_BUILD_SKEW` | `http` | 409 | client build ID incompatible with the server contract | `reload` (client-side signal) |
| `X_RATE_LIMITED` | `http` | 429 | token bucket exhausted for `(tenant, actor, route)` | retry after `data.retryAfterMs` |
| `X_CATALOG_MISSING_KEYS` | `i18n` | build | a locale's catalog lacks a key source calls `t()` with | `x i18n sync <locale>` |
| `X_CURRENCY_MISMATCH` | `money` | 500 | arithmetic across two currencies | convert explicitly first |
| `X_TIMEZONE_INVALID` | `time` | 500 | a `zone` that is not an IANA identifier | pass an IANA id such as `Europe/Berlin`, never `CET` |
| `X_TEST_NETWORK_SEALED` | `testing` | test | unmocked egress inside a test | mock the named URL |

There is no runtime code for *formatting with no zone at all*: `FormatContext.zone` is required
(`packages/time/src/format.ts:14-18`), so an omitted zone is a type error and never reaches a throw.
`X_TIMEZONE_INVALID` covers the case a type cannot — a string that is not an IANA name.

Package-local codes live with their subsystem: jobs in [`08-jobs-internals.md`](./08-jobs-internals.md), realtime in [`07-realtime-internals.md`](./07-realtime-internals.md), rendering/SEO/PWA in [`09-rendering-internals.md`](./09-rendering-internals.md).
