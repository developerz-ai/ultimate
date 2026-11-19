# Building your own base

**Ultimate ships mechanism; your app ships convention.** Ultimate's own conventions are structural —
file naming, the four surfaces, the tier order — and they ship as build errors. Your *business*
conventions are yours, and a primitive is a function returning a value, so you encode one by
wrapping and exporting your own factory. No fork, no monkey-patch, no plugin API, no release to
wait for.

Everything downstream treats the result identically — registry, manifest, projections, admin,
MCP, `x verify`.

**Re-run against 4.0.0** `As of 2026-08-20`: every fenced example on this page compiles under the
repository's own `tsconfig.base.json` (`strict`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `verbatimModuleSyntax`), and both compile errors quoted under
[Two caveats](#two-caveats) are `tsc`'s verbatim words at that setting. The `tenantEntity` example
was executed as well, and again `As of 2026-11-03` — `getEntity('invoices').describe()` answers columns `id, memo, orgId,
createdAt`, one index `invoices_org_id_idx` on `org_id`, `orgScoped: true`, and
`invoices.$tenantColumn` is `'orgId'`. The projections are run too, on every gate:
`packages/cli/src/third-party-wrapper.test.ts` installs a factory-built entity, an MCP-exposed
action and a job from a package under `node_modules/`, re-exports them from an app, and asserts
`x entities`, the manifest and `tools/list` hold them, the action's policy refuses a caller without
the grant, and the job runs. It fails the day any of those learns where a primitive came from.

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
    idempotent: true, // required on every mutator — see Actions
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
| `defineApi({ actions })` | names each export **in place**, so `getAction('issueInvoice') === issueInvoice` by identity, not a copy |
| `x verify` | no step matches source text for `action(` / `entity(` / `mutator(`. Every primitive fact reaches the gate by importing the module and reading the runtime registries. The only text scanning is for `X_*` codes |
| manifest · admin CRUD · MCP · the five projections | all read those same registries |

## Two caveats

Both will bite. Both are the app's job, one line each.

| Caveat | Fix |
|---|---|
| **A factory must add its own index for a column it injects.** `IndexInit` is keyed on the *caller's* columns — correctly, since a call site cannot name a column it did not declare. `tenantEntity('invoices', { indexes: [{ on: ['orgId'] }] })` is a compile error: `Type '"orgId"' is not assignable to type '"id" \| "memo"'` | put the index inside the factory, next to the column it belongs to — as `tenantEntity` above does |
| **A factory building a derived schema must be generic over `AnySchema`**, exported from `@ultimat3/schema`. `<TOut extends StandardSchemaV1>` is *not* assignable to `AnySchema`, so `t.object({ data: out })` fails with `Type 'TOut' is not assignable to type 'AnySchema'` | constrain to `AnySchema`. `StandardSchemaV1` is the interop contract; `AnySchema` is the framework's own supertype and the one `t.object` accepts |

## An error code is declared, not wrapped

A primitive is wrapped; an error code is not. Declare each code at its own call site with
`defineError({ code: 'X_INVOICE_NOT_FOUND', title, status: 404, cause, fix })` from
`@ultimat3/core/page` — the title, the HTTP status and the class in one call. The `errors` step and the
manifest read the `code:` literal where it is written, so a factory that takes the code as a
parameter hides it (`X_ERROR_CODE_UNRESOLVED`). A family of codes is a prefix (`X_BILLING_*`),
never a base class: `guards/error-declared.ts` refuses `extends UltimateError`, and
`InvoiceNotFound.is(error)` matches the code where `instanceof` cannot — a browser's rebuilt
refusal included.

## Publish it

A base that two of your apps share, or that strangers could use, is an npm package. Nothing
registers it: the app re-exports what it wants, and the framework sees primitives.

| Rule | Why |
|---|---|
| name it `ultimate-<name>`, unscoped, with the keyword `ultimate-package` | `npm search keywords:ultimate-package` is the directory. There is no marketplace, registry or plugin API (axiom 8). `@ultimat3/` is reserved for the framework |
| `@ultimat3/*` in `peerDependencies` at `^<major>`, for every package it imports — never `dependencies` | the app's own install is the one copy of each registry; a second copy is a second registry the app's gate never reads |
| ship JavaScript (or `.ts` Bun can run) with `exports` | a consumer's `bun install` is the whole integration |
| no `tier` | tiers order the framework's own packages (`scripts/lib/tiers.ts`); a third-party package sits beside the app, below nothing |
| guards are copied, not imported | an app's `guards/*.ts` are its own files and `x verify` runs only those. A package that ships a guard ships it as a file the README tells the author to copy |

```json
{
  "name": "ultimate-acme-log",
  "version": "1.0.0",
  "type": "module",
  "exports": { ".": "./index.js" },
  "keywords": ["ultimate-package"],
  "peerDependencies": {
    "@ultimat3/action": "^30.0.0",
    "@ultimat3/entity": "^30.0.0",
    "@ultimat3/jobs": "^30.0.0",
    "@ultimat3/policy": "^30.0.0"
  }
}
```

The app takes what it wants by re-export, in the surface the primitive belongs to: one line,
`export { acmeLog } from 'ultimate-acme-log';`, in `apps/web/app/acme/entity.ts`.

What a consumer's `x verify` sees: the package's entity in `drift` (its table needs a migration,
`x db gen`), its actions and jobs in `manifest` and `contract-diff`, its permissions in `policy`
(the app's roles grant them), its MCP tools in the tool list. It
does **not** see the package's own tests, lint or guards: those are the package's to run.

A **starter** (a whole app shape, not a factory) is not a package: it is a repository a person
copies, and its README says so. Once one exists, a community list is a wiki page added by pull
request.

## Recipe: a PIN for a shared device

Decided 2026-11-14 (plan 101, owner decision OD6): a PIN or device-operator sign-in is **a recipe,
not a framework method**. One adopter needed it, in two files, and every rule it needs already
ships. A shared device (a till, a kiosk, a shop-floor tablet) signs in once as a device account;
an operator then proves who they are with a short PIN, and that browser's session becomes theirs.

| Piece | Where it lives | What it calls |
|---|---|---|
| the device account | an `x_users` row with the app's own `device` role, signed in by the normal sign-in | `login()` |
| the operator's PIN | the app's own entity (`operators`: `userId`, `pinHash`), never `x_users.password_hash` — a PIN is weaker than the password policy allows (`X_PASSWORD_WEAK`) | `hashPassword(pin)` on enrolment |
| the lockout | **before** the KDF, keyed per operator and per device: a 4-digit PIN is 10 000 guesses, so the budget is the whole defence | `appAuth().limiter.reserve('pin:<operatorId>:<deviceId>')` — `X_ACCOUNT_LOCKED` refuses; `recordSuccess` on a match |
| the check | constant cost whether or not the operator exists | `verifyPassword({ hash: row?.pinHash ?? null, password: pin })` |
| the switch | a session for the operator, capped at the device session's ceiling, set as that browser's cookie; signing the operator out lands on the device sign-in again | `createSession(appAuth().sessions, { userId: operator.userId, absoluteExpiresAt: device.absoluteExpiresAt })`, then `setCookie(sessionCookie(issued.token, appAuth().sessions.policy))` from the action |
| who may switch | the app's policy on its own `switchOperator` action: the caller holds the `device` role | `can('operator:switch', …)` |

The action is the app's (`apps/web/app/operators/actions/switch-operator.ts`), so it projects like
any other — route, typed client, MCP tool, contract test. Nothing in the framework learns that a PIN
exists, which is the point: the next app's PIN rules (length, rotation, which devices) are its own.

The check itself, one file the action calls with the operator row it loaded. `switchOperator` knows
nothing of HTTP, so a job or a test can run it; the action's `handle` calls
`switchOperatorOnResponse`, and no route carries the cookie:

```ts
// apps/web/shared/base/operator-pin.ts
import {
  type Auth,
  type AuthSession,
  createSession,
  hashPassword,
  type IssuedSession,
  loginFailed,
  sessionCookie,
  verifyPassword,
} from '@ultimat3/auth';
import { setCookie } from '@ultimat3/http';

/** The app's `operators` row: whose PIN, and its hash. Never `x_users.password_hash`. */
export interface OperatorRow {
  readonly userId: string;
  readonly pinHash: string;
}

export interface OperatorSwitch {
  readonly operatorId: string;
  readonly pin: string;
  /** `null` when no operator has that id — checked at the same cost as a wrong PIN. */
  readonly operator: OperatorRow | null;
  /** The device account's session, as `authenticate` resolved it. */
  readonly device: Pick<AuthSession, 'userId' | 'absoluteExpiresAt'>;
}

/** Enrolment: the same KDF a password gets, so a leaked table is not 10 000 cheap guesses. */
export const enrolPin = (pin: string): Promise<string> => hashPassword(pin);

/**
 * The PIN proves the operator; the answer is their session, capped at the device's, and the
 * cookie line the response sets. The attempt is RESERVED before the KDF, per operator and per
 * device: a fifth wrong PIN locks that pair (`X_ACCOUNT_LOCKED`), and every refusal before it is
 * `loginFailed()` — one code whether the PIN was wrong or the operator does not exist.
 */
export async function switchOperator(
  auth: Auth,
  input: OperatorSwitch,
): Promise<{ readonly issued: IssuedSession; readonly cookie: string }> {
  const key = `pin:${input.operatorId}:${input.device.userId}`;
  await auth.limiter.reserve(key);
  const hash = input.operator?.pinHash ?? null;
  const verdict = await verifyPassword({ hash, password: input.pin });
  if (!verdict.ok || input.operator === null) throw loginFailed();
  await auth.limiter.recordSuccess(key);
  const issued = await createSession(auth.sessions, {
    userId: input.operator.userId,
    absoluteExpiresAt: input.device.absoluteExpiresAt,
  });
  return { issued, cookie: sessionCookie(issued.token, auth.sessions.policy) };
}

/** The action's half: the same switch, its cookie set on the response to this request. */
export async function switchOperatorOnResponse(
  auth: Auth,
  input: OperatorSwitch,
): Promise<IssuedSession> {
  const { issued, cookie } = await switchOperator(auth, input);
  setCookie(cookie);
  return issued;
}
```

The comparison is the KDF's, constant-time inside `Bun.password.verify`; a PIN is never hashed
with a fast digest and compared with `timingSafeEqual`, because four digits under SHA-256 are
reversed from a leaked table in milliseconds. The lockout is `Auth.limiter`, so a deployment that
declared `rateLimit.scope: 'shared'` counts PIN guesses fleet-wide with no change here.

## Recipe: billing

Billing is **not** a package (axiom 8): a price list, a refund rule and a dunning schedule are a
business's, and a framework that shipped one would ship the wrong one. It is one app file over
three shipped primitives — `defineFlag` for entitlements, `webhookReceiver` for the payment
provider's events, `Money` for prices.

| Piece | Where it lives | What it calls |
|---|---|---|
| plans and prices | `PLANS`, a constant: `Money` is `{ minor, currency }`, never a float | `equals` from `@ultimat3/money` |
| an entitlement | a **permanent** flag whose subject is the org's plan: `{ subjects: { plan: [...] } }` | `defineFlag`, `isEnabled(key, actor, { plan })` |
| a comp, a trial, a grandfathered org | the same flag, its targeting moved by an operator — `orgs: ['org_…']` | `applyFlagSnapshot` |
| the provider's event | a signed POST, verified over the exact bytes, enqueued, acknowledged | `webhookReceiver`, `verifyBodyHmac` |
| the plan change | the receiver's job: the paid amount must equal the plan's price, then the app's table moves | `PlanStore.setPlan`, one `step.run` |

```ts
// apps/web/shared/base/billing.ts
import type { Actor } from '@ultimat3/core';
import { defineError } from '@ultimat3/core/page';
import { defineFlag, isEnabled } from '@ultimat3/flags';
import { verifyBodyHmac } from '@ultimat3/http';
import { webhookReceiver } from '@ultimat3/jobs';
import { equals, type Money } from '@ultimat3/money';
import { type JsonValue, parse, t } from '@ultimat3/schema';

/** The price list is the app's. A price is integer minor units and a currency, never a float. */
export const PLANS = {
  free: { price: { minor: 0, currency: 'USD' } },
  team: { price: { minor: 4_900, currency: 'USD' } },
  scale: { price: { minor: 19_900, currency: 'USD' } },
} as const satisfies Record<string, { readonly price: Money }>;

const PLAN_IDS = ['free', 'team', 'scale'] as const satisfies readonly (keyof typeof PLANS)[];
export type PlanId = (typeof PLAN_IDS)[number];

/** An entitlement is a permanent flag, and the org's plan is the subject it targets. */
export const entitlement = (name: string, description: string, plans: readonly PlanId[]) =>
  defineFlag({
    kind: 'permanent',
    key: `entitlement.${name}`,
    description,
    targeting: { default: false, subjects: { plan: plans } },
  });

/** Synchronous, so a policy predicate asks it: `entitled('exports', actor, row.plan)`. */
export const entitled = (name: string, actor: Actor | null, plan: PlanId): boolean =>
  isEnabled(`entitlement.${name}`, actor, { plan });

export const BillingEventMalformed = defineError({
  code: 'X_BILLING_EVENT_MALFORMED',
  title: 'a signed billing event is not JSON',
  status: 422,
  cause: 'the payment provider signed a body that does not parse as JSON',
  fix: "x jobs list --name billing.events --json   # then compare the provider's event log",
});

export const BillingAmountMismatch = defineError<{ readonly plan: PlanId }>({
  code: 'X_BILLING_AMOUNT_MISMATCH',
  title: 'a paid amount is not the plan price',
  offSocket: true,
  retry: 'terminal',
  cause: (p) => `the provider charged an amount for plan ${p.plan} that is not PLANS.${p.plan}.price`,
  fix: (p) => `edit apps/web/shared/base/billing.ts: set PLANS.${p.plan}.price to what the provider charges`,
});

/** The event, as the provider signs it. Vendor-neutral here; an app maps its provider's shape. */
const PlanChanged = t.object({
  id: t.string,
  type: t.literal('plan.changed'),
  orgId: t.string,
  plan: t.enumerated(...PLAN_IDS),
  amount: t.money,
});

/** The app's own table. Idempotent on `eventId`: a redelivered event writes nothing twice. */
export interface PlanStore {
  setPlan(orgId: string, plan: PlanId, eventId: string): Promise<void>;
}

export interface BillingReceiverInit {
  /** Read per delivery, never captured: a rotation is a list, and any of it verifies. */
  readonly secret: () => string | readonly string[];
  readonly plans: () => PlanStore;
}

/** POST `/hooks/billing`: verify the signature over the exact bytes, then queue the change. */
export const billingReceiver = (init: BillingReceiverInit) =>
  webhookReceiver({
    name: 'billing.events',
    path: '/hooks/billing',
    tenant: (event) => event.orgId,
    verify: (inbound) => {
      const { text } = verifyBodyHmac({
        bytes: inbound.bytes,
        secret: init.secret(),
        given: inbound.headers.get('x-billing-signature'),
        encoding: 'hex',
      });
      let body: JsonValue;
      try {
        body = JSON.parse(text ?? '');
      } catch {
        throw new BillingEventMalformed();
      }
      // Refused here, before anything queues: a body that is not this event is a 422 to the sender.
      const event = parse(PlanChanged, body);
      return { eventId: event.id, orgId: event.orgId, topic: event.type, payload: body };
    },
    handle: async ({ eventId, payload, step }) => {
      const change = parse(PlanChanged, payload);
      if (!equals(change.amount, PLANS[change.plan].price)) {
        throw new BillingAmountMismatch({ plan: change.plan });
      }
      await step.run('set-plan', () => init.plans().setPlan(change.orgId, change.plan, eventId));
    },
  });
```

Declare it once, beside the entitlements the app sells:

| Call | Where |
|---|---|
| `export const exports = entitlement('exports', 'CSV and PDF exports', ['team', 'scale']);` | `apps/web/shared/base/entitlements.ts` |
| `export const billingEvents = billingReceiver({ secret: () => (Bun.env['BILLING_WEBHOOK_SECRET'] ?? '').split(','), plans: () => planRepo });` | `apps/web/app/billing/jobs/billing-events.ts`, listed in `apps/web/api/index.ts`'s `jobs:` — where `x g webhook-receiver` puts one; the boot mounts its route |
| `can('export:run', ({ actor, row }) => row !== null && entitled('exports', actor, row.plan))` | the policy on the export action — the org's plan is a row the action loads |

The signature check is `verifyBodyHmac`: HMAC-SHA256 over the exact bytes, compared with core's
`timingSafeEqual` under every secret of a rotation. A bad one is `X_WEBHOOK_SIGNATURE_INVALID`
(401) and queues nothing; a redelivery while the job is live is deduped by `eventId`; after it
settles the handler runs at least once, which is why `setPlan` is keyed on `eventId`. What a
provider calls an event, a proration, a failed card: the app maps them in `verify` and `handle`.

## Recipe: PDF assembly

The framework prints; the app assembles. `pdf()` (`@ultimat3/scraping`) is a factory over
`action`: it renders one of the app's **own routes** in Chrome and writes the bytes to a disk,
gated by the action's policy. A document of many parts — a cover, line items, an appendix — is
one route the app composes in HTML, page breaks in CSS (`break-before: page`), printed once.
**No PDF merge ships**: two printed files are never concatenated; a pack is one route that renders
every part. What the app's convention adds is one layout, one disk and one key scheme.

```ts
// apps/web/shared/base/document-pdf.ts
import type { ActionPolicy } from '@ultimat3/action';
import type { Actor } from '@ultimat3/core';
import { defineError } from '@ultimat3/core/page';
import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { type PdfLayout, type PdfRenderer, pdf } from '@ultimat3/scraping';
import { disk } from '@ultimat3/storage';

/** Every document this app prints: A4, one margin, page numbers in the footer — Chrome fills them. */
export const HOUSE_LAYOUT: PdfLayout = {
  format: 'a4',
  marginMm: { top: 18, right: 16, bottom: 18, left: 16 },
  printBackground: true,
  footerHtml: '<span class="pageNumber"></span> / <span class="totalPages"></span>',
};

export const DocumentOrgRequired = defineError({
  code: 'X_DOCUMENT_ORG_REQUIRED',
  title: 'a document is printed for an organisation',
  status: 403,
  cause: 'the caller has no organisation, so the document has no tenant folder to land in',
  fix: "can('<document>:print', ({ actor }) => actor?.orgId !== undefined)   # on the document's policy",
});

const orgOf = (actor: Actor): string => {
  if (actor.orgId === undefined) throw new DocumentOrgRequired();
  return actor.orgId;
};

interface DocumentDef<TInput extends StandardSchemaV1<unknown, { readonly id: string }>> {
  /** The folder on the `documents` disk: `invoice`, `statement`. */
  readonly kind: string;
  readonly input: TInput;
  readonly policy: ActionPolicy;
  /** The app route that ASSEMBLES the document — its parts, in order, as HTML the app owns. */
  route(input: InferOutput<TInput>): string;
  /** Tests hand in a renderer; production prints through the shared Chrome. */
  readonly renderer?: PdfRenderer | undefined;
}

/** A document is an action: HTTP, OpenAPI, MCP, `.job()` for a batch — and the same policy. */
export const documentPdf = <TInput extends StandardSchemaV1<unknown, { readonly id: string }>>(
  def: DocumentDef<TInput>,
) =>
  pdf({
    input: def.input,
    policy: def.policy,
    route: ({ input }) => def.route(input),
    key: ({ input, ctx }) => `${orgOf(ctx.actor)}/${def.kind}/${input.id}.pdf`,
    storage: () => disk('documents'),
    layout: HOUSE_LAYOUT,
    renderer: def.renderer,
  });
```

| Call | Answers |
|---|---|
| ``export const statementPdf = documentPdf({ kind: 'statement', input: t.object({ id: t.string }), policy: statementRead, route: ({ id }) => `/statements/${id}/print` })`` | `{ key: '<org>/statement/<id>.pdf', bytes, contentType }`, never the bytes |
| `await statementPdf.job().enqueue(…)` per org at month end | the batch, on the worker, with the action's policy |

The route is private, so `pdf()`'s `headers` option carries a short-lived token the app signs, and
the browser sends it only to the route's own origin. Chrome is a runtime dependency of the image
that prints (`CHROME_PATH`), and `chromePdfRenderer({ maxConcurrent })` bounds how many run.

## Recipe: a named proxy pool

`scrape({ egress })` (`@ultimat3/scraping`) names the exit **one run** leaves through, resolved in
the worker. A pool — several exits under one name, a session kept on one of them — is the app's,
because which provider, how many exits and what "sticky" means are business decisions.

```ts
// apps/web/shared/base/proxy-pool.ts
import { defineError } from '@ultimat3/core/page';

export const ProxyPoolEmpty = defineError<{ readonly variable: string }>({
  code: 'X_PROXY_POOL_EMPTY',
  title: 'a named proxy pool has no exit',
  offSocket: true,
  retry: 'terminal',
  cause: (p) => `${p.variable} is unset or empty in the worker, so the pool has no exit to hand out`,
  fix: (p) => `printf '%s' 'http://user:pass@exit-1.example:8080,http://user:pass@exit-2.example:8080' | x secrets set ${p.variable}`,
});

export interface ProxyPool<I> {
  readonly name: string;
  /** The secret holding the exits, comma-separated: `PROXY_POOL_<NAME>`. */
  readonly variable: string;
  /** For `scrape({ egress })`: the same subject always leaves through the same exit. */
  egress(input: I): string;
}

/**
 * `stickyBy` names the subject a site must see on one address — a connection, an account. Its
 * hash picks the exit, so every worker agrees with no table. The exits are read per run, in the
 * worker, so neither a URL nor its password ever rides the queue row.
 */
export function proxyPool<I>(name: string, stickyBy: (input: I) => string): ProxyPool<I> {
  const variable = `PROXY_POOL_${name.toUpperCase().replaceAll('-', '_')}`;
  return {
    name,
    variable,
    egress(input) {
      const exits = (Bun.env[variable] ?? '')
        .split(',')
        .map((exit) => exit.trim())
        .filter((exit) => exit !== '');
      const exit = exits[Number(Bun.hash.wyhash(stickyBy(input)) % BigInt(exits.length || 1))];
      if (exit === undefined) throw new ProxyPoolEmpty({ variable });
      return exit;
    },
  };
}
```

| Call | Where |
|---|---|
| `export const residential = proxyPool<{ connectionId: string }>('residential', (input) => input.connectionId);` | `apps/web/shared/base/pools.ts` |
| `scrape({ …, egress: residential.egress, concurrency: { key: (input) => input.connectionId, limit: 1 } })` | the scrape; the input carries the connection id, never an exit |
| `printf '%s' '<exit>,<exit>' \| x secrets set PROXY_POOL_RESIDENTIAL` | once per environment |

The exit's password is concealed in every artifact and log line the run writes, and an exit whose
credential is also in the input is refused before the browser opens
(`X_SCRAPE_EGRESS_IN_PAYLOAD`). Adding an exit moves some subjects to new addresses — the hash
spreads over the list as it stands; a pool that must never move a subject keeps the assignment in
the connection's own row, and `egress` reads that row instead.

## Every recipe here runs

`As of 2026-11-16`, each `ts` fence under a `Recipe:` heading is compiled by the gate
(`scripts/wiki-fences.ts`) and **run**: `bun test ./scripts/base-recipes/` writes the fence to the
path its first line names, in a scratch app, imports it and drives it — a signed event moving an
entitlement, a document landing on its disk, a fifth wrong PIN locking, a subject keeping its exit.
The gate's `unit` step runs them on every change, and `.github/workflows/tutorial-run.yml` on every
push to `main` that touches this page.

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
