# Building your own base

**Ultimate ships mechanism; your app ships convention.** Ultimate's own conventions are structural —
file naming, the four surfaces, the tier order — and they ship as build errors. Your *business*
conventions are yours, and a primitive is a function returning a value, so you encode one by
wrapping and exporting your own factory. No fork, no monkey-patch, no plugin API, no release to
wait for.

Everything downstream treats the result identically — registry, manifest, projections, admin,
MCP, `x verify`.

**Re-run against 2.0.0** `As of 2026-08`: every fenced example on this page compiles under the
repository's own `tsconfig.base.json` (`strict`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `verbatimModuleSyntax`), and both compile errors quoted under
[Two caveats](#two-caveats) are `tsc`'s verbatim words at that setting. The `tenantEntity` example
was executed as well — `getEntity('invoices').describe()` answers columns `id, memo, orgId,
createdAt`, one index `invoices_org_id_idx` on `org_id`, `orgScoped: true`, and
`invoices.$tenantColumn` is `'orgId'`. What was **not** re-run: the manifest, admin and MCP
projections over a factory-built primitive — those rest on the registry facts in
[Why nothing downstream notices](#why-nothing-downstream-notices), not on a run.

Put the factory in a surface both `app/` and `api/` may import — `apps/web/shared/base/` in the
generated layout ([Project layout](Project-Layout)).

## A tenant entity

```ts
// apps/web/shared/base/tenant-entity.ts
import { entity, timestamp, uuid, type ColumnMap, type EntityInit } from '@ultimat3/entity';

/** Every table in this app is org-scoped and stamped. Declared once, not at forty call sites. */
export const tenantEntity = <const C extends ColumnMap>(name: string, init: EntityInit<C>) =>
  entity(name, {
    ...init,
    columns: { ...init.columns, orgId: uuid().tenant(), createdAt: timestamp().defaultNow() },
    indexes: [...(init.indexes ?? []), { on: ['orgId'] }],
  });
```

```ts
// apps/web/app/invoices/entity.ts
import { text, uuid } from '@ultimat3/entity';
import { tenantEntity } from '../../shared/base/tenant-entity';

export const invoices = tenantEntity('invoices', {
  columns: { id: uuid().primaryKey(), memo: text() },
});

export type Invoice = typeof invoices.$row;
```

What it buys:

| Before | After |
|---|---|
| every entity file remembers `orgId: uuid().tenant()` | tenancy is a property of the base, unforgettable |
| a forgotten tenant column is an unscoped read that ships | there is no way to declare an unscoped table through this factory |
| the `orgId` index is remembered per table, or is not | it arrives with the column |
| `createdAt` drifts in name and default across features | one spelling, one default |

The row type still derives from the merged column set: `Invoice` carries `orgId` and `createdAt`
without a second declaration. `invoices.$tenantColumn` is `'orgId'`, and a read built without an org
predicate throws `X_TENANCY_UNSCOPED` exactly as it would for a hand-written entity.

## A mutator factory

The pattern is not entity-specific. Any primitive is a function returning a value, so any primitive
wraps:

```ts
// apps/web/shared/base/audited-mutator.ts
import { mutator, type ActionPolicy, type LocalTx, type Mutator } from '@ultimat3/action';
import type { Ctx } from '@ultimat3/core';
import type { AnySchema, InferOutput } from '@ultimat3/schema';

interface AuditedDef<TIn extends AnySchema, TOut extends AnySchema> {
  readonly input: TIn;
  readonly output: TOut;
  readonly policy: ActionPolicy;
  readonly event: string;
  local(tx: LocalTx, input: InferOutput<TIn>): void;
  server(ctx: Ctx, input: InferOutput<TIn>): Promise<InferOutput<TOut>>;
}

/** Every write in this app records who did what. `conflict` is a house decision, made once. */
export const auditedMutator = <TIn extends AnySchema, TOut extends AnySchema>(
  def: AuditedDef<TIn, TOut>,
): Mutator<TIn, TOut> =>
  mutator({
    input: def.input,
    output: def.output,
    policy: def.policy,
    conflict: 'server-wins',
    local: def.local,
    server: async (ctx, input) => {
      const row = await def.server(ctx, input);
      ctx.logger.info('audit', { event: def.event, actor: ctx.actor.id });
      return row;
    },
  });
```

The result is a `Mutator`, which **is** an `Action` — so it keeps its route, its OpenAPI operation,
its typed client method, its MCP tool, its job handle and its contract test, and its authz is still
the one evaluation. The same shape works over `action()`, `job()` and `query()`.

## Why nothing downstream notices

| Machinery | Why the wrapper is invisible |
|---|---|
| the entity registry | `entity()` calls `registerEntity` itself, so registration happens whenever your factory calls it |
| `isAction()` | structural — a function, `kind === 'action'`, a stashed declaration. It asks whether `action()` built the value, never where |
| `registerActions(module)` | names the export **in place**, so `getAction('issueInvoice') === issueInvoice` by identity, not a copy |
| `x verify` | no step matches source text for `action(` / `entity(` / `mutator(`. Every primitive fact reaches the gate by importing the module and reading the runtime registries. The only text scanning is for `X_*` codes |
| manifest · admin CRUD · MCP · the five projections | all read those same registries |

## Two caveats

Both will bite. Both are the app's job, one line each.

| Caveat | Fix |
|---|---|
| **A factory must add its own index for a column it injects.** `IndexInit` is keyed on the *caller's* columns — correctly, since a call site cannot name a column it did not declare. `tenantEntity('invoices', { indexes: [{ on: ['orgId'] }] })` is a compile error: `Type '"orgId"' is not assignable to type '"id" \| "memo"'` | put the index inside the factory, next to the column it belongs to — as `tenantEntity` above does |
| **A factory building a derived schema must be generic over `AnySchema`**, exported from `@ultimat3/schema`. `<TOut extends StandardSchemaV1>` is *not* assignable to `AnySchema`, so `t.object({ data: out })` fails with `Type 'TOut' is not assignable to type 'AnySchema'` | constrain to `AnySchema`. `StandardSchemaV1` is the interop contract; `AnySchema` is the framework's own supertype and the one `t.object` accepts |

## The honest limit

**The registry cannot tell that an entity came from your factory, and that erasure is the feature.**
`getEntity('invoices').describe()` reports columns, indexes and references — never `tenantEntity`.
A factory-built primitive is indistinguishable from a hand-written one, which is precisely why the
manifest, admin, MCP and the gate need no knowledge of your base.

The consequence for tooling: a subagent, a reviewer or a doc generator learns your house base **from
your source**, not from the registry. Name the factory for what it guarantees, keep it in one file
under `shared/base/`, and say so in your app's `AGENTS.md` — that file exists for conventions an
agent cannot infer.

This is not a gap awaiting a fix. A registry that recorded the factory would make your convention a
framework fact, and the next thing that read it would start depending on it.

## Read next

| Page | Why |
|---|---|
| [The eight primitives](The-Eight-Primitives) | the vocabulary you are wrapping |
| [Entities and migrations](Entities-And-Migrations) | tenancy, invariants, what a merged column set migrates to |
| [Actions](Actions) | the six artifacts a wrapped action still projects |
| [`docs/idea/19-mechanism-not-convention.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/19-mechanism-not-convention.md) | axiom 8: which decisions are the framework's and which are yours |
