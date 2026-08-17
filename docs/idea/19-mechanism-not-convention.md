# Mechanism and convention

**Ultimate ships mechanism; your app ships convention.** `As of 2026-08`.

Ultimate is opinionated, so it obviously ships conventions — `kebab-case.ts`, `page.tsx` on `site/`
and `app/` against `route.ts` on `api/`, the directory is the URL, one flat i18n catalog per locale,
tests beside source, six import tiers. Those are the point. The line this axiom draws is not
*whether* a convention ships, it is **which kind**.

| Kind | Example | Ships? | Why |
|---|---|---|---|
| **Mechanism** | tenancy derived from the actor rather than read from input, integer money carrying its currency, a flag axis keyed by subject kind, HMAC verification, retry with a backoff | **yes** | correct or incorrect whatever the business. Get one wrong and every app is broken |
| **Structural convention** | file naming, the four surfaces, where a route lives, catalog layout, tier order | **yes**, as build errors | the same for a bank and a blog. An app gains nothing by disagreeing, and predictability is what an agent is buying |
| **Business convention** | what an org is, whether members hold seats, what a plan tier grants, which fields a domain audit row carries, what a flag-subject helper is called | **no** | differs per app by nature. Shipping one guesses at somebody's business |

And the conventions that do ship stay **adjustable where it matters** — by wrapping, not by forking.
That is the second half of the axiom, and it is why the first half is not a straitjacket.

## The test

Applies to business convention, which is the only kind in doubt. Ask what happens if the framework
picks wrong.

| | Mechanism | Business convention |
|---|---|---|
| Wrong outcome | every app is broken | every app is *shaped* — and the dissenters get a second path |
| Evidence it is missing | apps hand-roll the **same** thing | apps hand-roll **different** things |
| Correct home | the framework | a wrapper in the app |
| Who may change it | nobody — it is a property | the app, in one file, today |

A shipped business convention is worse than a missing one. The apps that agree gained a shortcut;
the apps that disagree now have two ways to do one thing — [axiom 1](./00-thesis.md#design-axioms)
broken by the framework on its users' behalf.

**Independent reinvention is evidence of a framework gap only when the reinventions agree.** Four
teams building a webhook verifier the same way is a mechanism the framework should own. Four teams
building four different org models is a business convention, and shipping one of them would have
made three of them wrong.

## The seam is the wrapper

An app composes primitives into its own base and builds on that. **Re-run against 2.0.0**
`As of 2026-08`: it compiles under the repository's own `tsconfig.base.json`, and the entity it
declares registers with the merged column set and `orgScoped: true`.

```ts
// apps/web/shared/base/tenant-entity.ts — the app's convention, written once
import { entity, timestamp, uuid, type ColumnMap, type EntityInit } from '@ultimat3/entity';

export const tenantEntity = <const C extends ColumnMap>(name: string, init: EntityInit<C>) =>
  entity(name, {
    ...init,
    columns: { ...init.columns, orgId: uuid().tenant(), createdAt: timestamp().defaultNow() },
    indexes: [...(init.indexes ?? []), { on: ['orgId'] }],
  });
```

Every table declared through it is org-scoped by construction. Tenancy stops being something forty
call sites remember, and `X_TENANCY_UNSCOPED` stops being a bug an app can write.

Nothing downstream can tell the difference, and nothing downstream needs to:

| Fact | Why the wrapper is invisible |
|---|---|
| `entity()` registers | `registerEntity` is called from inside `entity()` ([`packages/entity/src/entity.ts:292`](../../packages/entity/src/entity.ts)) — whenever the factory calls it |
| `isAction()` accepts | structural: `typeof value === 'function'`, `kind === 'action'`, a stashed declaration ([`packages/action/src/action.ts:286`](../../packages/action/src/action.ts)). It asks whether `action()` built the value, never where |
| `getAction(name) === theExport` | `nameAction` stamps the name **in place** ([`:298`](../../packages/action/src/action.ts)), so the registry holds the app's own object, not a copy |
| the gate agrees | **no `x verify` step matches source text for `action(` / `entity(` / `mutator(`.** Every primitive fact reaches the gate through `loadApp` ([`packages/cli/src/app-load.ts`](../../packages/cli/src/app-load.ts)), which imports modules and reads the runtime registries. The only text scanning in the CLI is for `X_*` codes ([`ts-scan.ts`](../../packages/cli/src/ts-scan.ts)) |

So the manifest, all five projections (`.tool()` `.openapi()` `.client()` `.job()` `.contract()`),
admin CRUD and the MCP tool list work on a factory-produced primitive exactly as on a hand-written
one. That is the same rule the framework already applies to itself — `llm()` returns an action,
`backfill()` returns a job — so there is no second extension mechanism to learn.

**There is no plugin API, and none is planned.** [`00-thesis.md`](./00-thesis.md#explicit-exclusions)
excluded one on the grounds that extension points must earn their existence from real forks. Nothing
has, because function composition already is the extension point.

## Worked decisions

Every "what does not" below is a **business** convention. The structural conventions around them —
where the file lives, what it is called, which tier it may import — ship and are build errors.

| Capability | Verdict | What ships | What does not |
|---|---|---|---|
| Feature flags | mechanism | `isEnabled(key, actor, { bank: 'bank_integration:bbva' })` — an open kind space, a loud `X_FLAG_SUBJECT_REQUIRED` when a call site omits the kind a flag targets | `flagSubject()` sugar. Naming and shaping the subject is the app's vocabulary |
| Tenancy | mechanism | the tenant column as the switch, the org predicate enforced at the query seam, `X_TENANCY_UNSCOPED` when it is missing | an `org` entity, membership, roles, invites, seats. Four apps, four models — one of them shipped would make three wrong |
| Rate and cost limits | mechanism | `rateLimit: { limit, windowMs }` on any action | plans, tiers, entitlements, a quota counter, a seat ledger. There is no plan model in the framework and there will not be one |
| Audit | **split at the seam** | *that* an admin operation is recorded: an append-only `AuditLog` with `AuditSink`, no update, no delete, denied and failed attempts included ([`packages/admin/src/audit.ts`](../../packages/admin/src/audit.ts)) | *what a domain audit row says* — the approval chain, the reason code, the reviewer. An app factory over `mutator()` |

The audit row is the clearest case. Recording is a property: an unrecorded mutation is a defect in
every business. What the record *means* is not.

## Why value-returning functions extend where base classes do not

The complaint about mature frameworks is rarely a missing feature. It is that changing one costs a
fork — a consequence of *how* the opinion is expressed, not of having opinions:

| The opinion lives in | To change it you must | Cost |
|---|---|---|
| a base class you inherit | subclass and override, or monkey-patch | the override breaks on their next minor |
| a lifecycle you register into | find the hook, and hope one exists | no hook, no change — you fork |
| a configuration DSL | wait for the option to be added | file an issue, wait a year |
| **a value returned from a function** | **call it and wrap the result** | **a function in your own repo** |

Ultimate's primitives are the last row. `entity()`, `action()`, `mutator()`, `job()` are functions
returning values. Nothing to subclass, no lifecycle to hook, no option matrix to petition for.

**The practical test: an app should never need to fork Ultimate, monkey-patch it, or wait for a
release to encode its own business convention.** If it does, the primitive is shaped wrong — a
class, a lifecycle or a config surface wearing a function's clothes, and that is the bug.

Opinion belongs in the **defaults**, never in the exit. A framework that guesses at business
convention and closes the exit gets routed around, and loses its good parts on the way out: the
escape hatch people actually take is the raw layer underneath, and everything the framework was
doing for them goes with it.

## Modularity is the same rule, one level up

Wrapping is how you extend a primitive. **Tiering is how you take only the part you need.** Imports
go down tiers only, so a package's cost is bounded by its tier — and at the bottom that cost is
approximately nothing. Verified `As of 2026-08`:

| Package | Tier | Dependencies |
|---|---|---|
| `@ultimat3/core` | 0 | **none** |
| `@ultimat3/schema` | 0 | **none** |
| `@ultimat3/money` | 1 | `@ultimat3/core`, `@ultimat3/schema` — both `@ultimat3/*` |

Across all 29 published packages the only third-party runtime dependencies are **`nats`**
(`@ultimat3/realtime`) and **`sass`** (`@ultimat3/render`), both at a driver/transport seam, both
under [`18-build-vs-wrap.md`](./18-build-vs-wrap.md)'s criterion:

```sh
jq -r '(.dependencies // {}) | keys[]' packages/*/package.json | grep -v '^@ultimat3/' | sort -u
# nats
# sass
```

So `bun add @ultimat3/money` is a reasonable thing to do in a project that is not an Ultimate app at
all — a Bun sidecar beside a Rails monolith, a one-off script, somebody else's framework — and it
costs three packages and no external code. Bun-only still applies: every package ships TypeScript
source through `exports` and declares `engines.bun >= 1.3.0`, so the consumer must be a Bun project,
just not an Ultimate one.

The tier table is usually described as an internal discipline. It is also a **consumer guarantee**,
and that guarantee is what makes adopting one piece as reasonable as adopting the whole.

## Transparency, not purity

We stand on other people's work and say whose. Everyone wraps — Rails wraps Rack and Puma.

| Rule | Meaning |
|---|---|
| Never reinvent a raw primitive | wire protocols, query planners, CSS compilers, browsers. Re-deriving one is where a framework's own bugs come from |
| Invent only the composition | the integration layer — transactions, `ctx`, the error contract, the outbox, the observer seam — is never delegated |
| Name the dependency | NATS is a choice we would defend, not a reluctant one. The ledger is in [`18-build-vs-wrap.md`](./18-build-vs-wrap.md#dependency-ledger) |

The wrap has a purpose beyond ergonomics: **making a raw primitive safe for a coding agent.** One
way to call it, declarative rather than procedural, wrong states unrepresentable in the type, and
errors that carry the fix command. A raw client is safe for someone who has read its manual; the
wrap is what makes it safe for someone who has not.

## The consequence: fewer tokens to a correct result

Every property above compounds into one outcome — **an agent working on an Ultimate app spends
fewer tokens to reach a correct result** — and each cause is something the framework already does:

| Property | Token effect |
|---|---|
| A declaration replaces an implementation | fewer **output** tokens — the agent writes a shape, not a system |
| One way to do each thing | no exploration; nothing to compare, choose between, or discover |
| Errors carry a stable code, a cause and a runnable `fix:` | a failure costs one round trip instead of a diagnostic loop |
| `--json` on every command and every error | output is parsed, never re-read or re-derived |
| Every package ships its `README.md` **and its `src/`** in the tarball | the answer is in `node_modules` — no web fetch, no wiki, no guessing |
| The gate is one command | "is it shippable" is one call, not a checklist |
| Conventions are build errors | the compiler corrects the agent, not a reviewer |
| Wrapping encodes a house rule once | the rule is not restated, re-read and re-remembered at N call sites |

### Honestly

**Not measured.** [`17-scale-ladder.md`](./17-scale-ladder.md#true-today-vs-intended) exists to stop
unmeasured claims drifting into shipped prose, and there is exactly one **measured** figure in this
repo — a single-node realtime recovery result. This one belongs on the same table, at a lower rung:

| Claim | State |
|---|---|
| each row of the table above is a real framework behaviour | **true** — every one is enforced code, not intent |
| those behaviours reduce an agent's token cost | **reasoned, never measured** — no run, no number |

The experiment that would settle it: **the same feature, the same model, the same prompt, built on
Ultimate and on a hand-rolled Bun stack, counting tokens to a green gate.** Until that runs, no
percentage appears on this page — a number a reader cannot check is worth less than a mechanism they
can.
