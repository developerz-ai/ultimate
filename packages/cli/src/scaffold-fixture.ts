// What the scaffold drift gate compiles: every documented `x new` invocation, with every `x g`
// generator run on top of the one that carries an app. Separate from the compiler harness next to
// it, because "which scaffolds exist" is a fact about the CLI's surface, not about running `tsc`.

import { withAdminResources } from './admin-registration';
import type { GenerateOptions } from './cmd-generate';
import { dedupe, generate } from './cmd-generate';
import { planNewApp } from './cmd-new';
import { withDeclaredExercises } from './generate-exercise';
import { withHandleEntries } from './handle-registration';
import { NEW_SHAPES } from './new-shapes';
import type { GeneratedFile } from './templates';

/** The app the fixture scaffolds. Kebab, multi-word: single-word names hide casing bugs. */
export const FIXTURE_APP = 'ledger-demo';

/** The fixture app's db package, as `x new` names it. */
const FIXTURE_DB = `@${FIXTURE_APP}/db`;

/**
 * An `errors.ts` an author wrote: it declares what the slice throws, and not the generated name.
 * The generator's INPUT only — the sandbox's own `errors.ts` is the one the resource wrote — so it
 * carries no `X_*` code: a literal here would be one shipped source hands a reader, and the
 * registry rule would ask where it was registered.
 */
export const HANDWRITTEN_ERRORS = `import { UltimateError } from '@ultimat3/core';

export class LedgerClosedError extends UltimateError {}
`;

/**
 * A feature slice whose entity is NOT tenant-scoped — the shape `x g entity`'s own comment
 * describes for a single-tenant app, and never a shape the generator writes itself. The
 * generator's INPUT only, the same way `HANDWRITTEN_ERRORS` above is: `x g job`/`x g task` read
 * this from a real `entity.ts`, and a fixture that never exercised it compiled only the shape
 * that never failed.
 */
export const HANDWRITTEN_ENTITY_NO_TENANT = `import { entity, text, uuid } from '@ultimat3/entity';

export const shortLink = entity('short_links', {
  columns: { id: uuid().primaryKey(), url: text({ max: 2000 }) },
});

export type ShortLink = typeof shortLink.$row;
`;

/** The paired `repo.ts`: no `byId`, no `listByOrg` — nothing this slice's job may call. */
export const HANDWRITTEN_REPO_NO_TENANT = `import { db, sql } from '@ultimat3/db';
import type { ShortLink } from './entity';

export async function list(limit = 50): Promise<readonly ShortLink[]> {
  return db().query<ShortLink>(sql\`select * from short_links order by url limit \${limit}\`);
}
`;

/**
 * A `policy.ts` an author wrote for the `invoice` slice: both names the generated action imports,
 * and a rule this generator cannot read — so its contract test asserts nothing about an org. The
 * shape whose unused `id`/`orgId`/`input` were a red `lint` on every such action.
 */
export const HANDWRITTEN_POLICY = `import { tag } from '@ultimat3/cache';
import { can } from '@ultimat3/policy';

export const invoiceTag = tag('invoice');
export const canInvoiceWrite = can('invoice:write');
`;

/**
 * The `invoice` resource's own `entity.ts`, as `x g` would read it off disk after the resource
 * below ran — the generators writing INTO that slice are handed it, because a slice with no entity
 * now gets the neutral body and no invented table.
 */
export const INVOICE_ENTITY = String(
  generate({ kind: 'entity', name: 'invoice' }).find((file) => file.path.endsWith('/entity.ts'))
    ?.contents,
);

/**
 * One realistic invocation of every generator, on top of `x new --example`. Names differ from
 * their feature on purpose: `x g query invoice --feature invoice` would collide with the entity
 * import, and a fixture that trips over its own naming stops testing the templates.
 *
 * `admin: true` on the resource is not decoration: `apps/web/app/<name>/admin/resource.ts` and its
 * test are templates no other invocation emits, and they cost nothing extra here because they land
 * in a sandbox that is compiled anyway.
 */
export const FIXTURE_GENERATORS: readonly GenerateOptions[] = [
  { kind: 'resource', name: 'invoice', admin: true },
  { kind: 'entity', name: 'credit-note', feature: 'credit-note' },
  { kind: 'policy', name: 'credit-note', feature: 'credit-note' },
  { kind: 'action', name: 'send-invoice', feature: 'invoice', sliceEntity: INVOICE_ENTITY },
  { kind: 'mutator', name: 'rename-invoice', feature: 'invoice', sliceEntity: INVOICE_ENTITY },
  // The other shape both templates have: a slice whose `errors.ts` is the author's and declares
  // no `InvoiceNotFoundError`. The resource's own `errors.ts` still lands in the sandbox (it does
  // declare one), which is the point — this compiles the file `x g action` writes when it must
  // not import that class, beside the one it writes when it may.
  {
    kind: 'action',
    name: 'ping-invoice',
    feature: 'invoice',
    sliceErrors: HANDWRITTEN_ERRORS,
    sliceEntity: INVOICE_ENTITY,
  },
  {
    kind: 'mutator',
    name: 'touch-invoice',
    feature: 'invoice',
    sliceErrors: HANDWRITTEN_ERRORS,
    sliceEntity: INVOICE_ENTITY,
  },
  // A slice's policy the author wrote: its contract test holds no constant it does not read.
  {
    kind: 'action',
    name: 'close-invoice',
    feature: 'invoice',
    sliceEntity: INVOICE_ENTITY,
    slicePolicy: HANDWRITTEN_POLICY,
  },
  {
    kind: 'mutator',
    name: 'reopen-invoice',
    feature: 'invoice',
    sliceEntity: INVOICE_ENTITY,
    slicePolicy: HANDWRITTEN_POLICY,
  },
  { kind: 'query', name: 'invoice-search', feature: 'invoice' },
  { kind: 'query', name: 'invoice-feed', feature: 'invoice', live: true },
  { kind: 'job', name: 'sweep-invoices', feature: 'invoice', sliceEntity: INVOICE_ENTITY },
  { kind: 'backfill', name: 'reindex-invoices', feature: 'invoice' },
  // The three factory generators, each into a slice of its own: none reads a table, so each must
  // compile in a feature with no entity — `ops` has none, which is the case that proves it.
  { kind: 'cron-job', name: 'nightly-report', feature: 'ops' },
  { kind: 'purge', name: 'purge-retained', feature: 'ops' },
  { kind: 'webhook-receiver', name: 'billing-events', feature: 'ops' },
  { kind: 'task', name: 'nightly-sweep', feature: 'invoice', sliceEntity: INVOICE_ENTITY },
  // The other shape both templates have: a feature whose entity names no tenant column, so the
  // job/task must not assume one — compiled here beside the tenant-scoped pair above, exactly as
  // `ping-invoice`/`touch-invoice` compile the action's other shape beside `send-invoice`.
  {
    kind: 'job',
    name: 'purge-orphans',
    feature: 'short-link',
    sliceEntity: HANDWRITTEN_ENTITY_NO_TENANT,
    sliceRepo: HANDWRITTEN_REPO_NO_TENANT,
  },
  {
    kind: 'task',
    name: 'nightly-purge',
    feature: 'short-link',
    sliceEntity: HANDWRITTEN_ENTITY_NO_TENANT,
    sliceRepo: HANDWRITTEN_REPO_NO_TENANT,
  },
  // And an action into that same slice: no `orgId` in its input, its tests or the policy it plants.
  {
    kind: 'action',
    name: 'ship-short-link',
    feature: 'short-link',
    sliceEntity: HANDWRITTEN_ENTITY_NO_TENANT,
    sliceRepo: HANDWRITTEN_REPO_NO_TENANT,
  },
  {
    kind: 'mutator',
    name: 'rename-short-link',
    feature: 'short-link',
    sliceEntity: HANDWRITTEN_ENTITY_NO_TENANT,
    sliceRepo: HANDWRITTEN_REPO_NO_TENANT,
  },
  // The same hand-written entity under a slice whose name is not its table's (`shortlink`, the
  // scaffold being `shortlinks`), and no `repo.ts`: nothing is planted around it.
  {
    kind: 'action',
    name: 'ship-link',
    feature: 'shortlink',
    sliceEntity: HANDWRITTEN_ENTITY_NO_TENANT,
  },
  {
    kind: 'mutator',
    name: 'rename-link',
    feature: 'shortlink',
    sliceEntity: HANDWRITTEN_ENTITY_NO_TENANT,
  },
  { kind: 'route', name: 'pricing', surface: 'site' },
  { kind: 'route', name: 'billing', surface: 'app' },
  // `--at`, pointed at the `site/` route above: an island's whole reason to exist is a 0kb page
  // that needs one interactive control, so the fixture places it where that is true.
  { kind: 'island', name: 'currency-picker', at: 'apps/web/site/pricing' },
  // The one screen the admin derives from nothing — and the one generator that must NOT emit a
  // `defineRoute`, so compiling it is how that stays true.
  { kind: 'admin:page', name: 'reconcile', permission: 'ledger:reconcile' },
  // The app's own convention. It is the only generated file that imports `@ultimat3/cli` for its
  // types, so compiling it is what proves a scaffolded app can actually write one.
  { kind: 'guard', name: 'migration-safety' },
  // The OIDC shape: its routes, its runtime and its provider module are the files the password
  // shape does not write. Both shapes, with the authenticator swap, compile whole in
  // `generate-sign-in.contract.test.ts`; one sign-in per app, so one here.
  { kind: 'sign-in', name: 'corp-sso', signIn: { kind: 'oidc', provider: 'corp-sso' } },
  // Helm YAML only — nothing here reaches the compiler. Listed so the coverage test stays a set
  // equality with `GENERATORS`: a later TS output from this generator is compiled without anyone
  // remembering to add it. `x new` writes the same two templates first, so `dedupe` keeps those.
  { kind: 'chart-alerts', name: FIXTURE_APP },
  { kind: 'chart-dashboard', name: FIXTURE_APP },
  // A workspace beside `apps/web`: `x g app` writes its manifest and tsconfig, `x g package` a
  // `src/index.ts` and its test — compiled here so a template drifting off the workspace's alias
  // or its strictness fails this gate, not the author's first `bun install`.
  { kind: 'app', name: 'billing', scope: FIXTURE_APP },
  { kind: 'package', name: 'pricing', scope: FIXTURE_APP },
];

/** The whole scaffolded surface: a new app, then every generator run inside it. */
export function scaffoldFixture(): readonly GeneratedFile[] {
  const files = dedupe([
    ...planNewApp({ name: FIXTURE_APP, example: true }),
    // `dbModule` is what `x g` reads off the app's own `packages/db/package.json`: without it the
    // generated repos import the handle from a placeholder package this sandbox does not have.
    ...FIXTURE_GENERATORS.flatMap((options) => generate({ ...options, dbModule: FIXTURE_DB })),
  ]);
  // What `x g` does on disk after it writes: each generated entity joins the handle's set.
  // …and each `--admin` override joins the admin's `resources:`, so its type is compiled where
  // `defineAdmin()` reads it.
  // …and each contract test's exercise entry joins `apps/web/exercise.ts` (`generate-exercise.ts`).
  return withDeclaredExercises(
    withAdminResources(withHandleEntries(files, FIXTURE_DB), `@${FIXTURE_APP}/web`),
  );
}

export interface ScaffoldVariant {
  /** Names the invocation in a failure, so a red gate says which `x new` broke. */
  readonly name: string;
  /** What this variant emits that no other one does — why it earns its own compile. */
  readonly why: string;
  readonly files: readonly GeneratedFile[];
}

/**
 * Every scaffold a user can ask for, each compiled on its own. One variant per *file set*, not per
 * flag: `--no-example` writes a different `packages/db` than `--example` does, and compiling only
 * the example app is what let `x new --no-example` ship a `schema.ts` importing a slice that
 * invocation never writes.
 */
export const scaffoldVariants = (): readonly ScaffoldVariant[] => [
  {
    name: 'x new',
    why: 'the example slice, plus one run of every generator on top of it',
    files: scaffoldFixture(),
  },
  {
    name: 'x new --no-example',
    why: 'an empty app/: no entity, so schema, seed and the initial migration have nothing to name',
    files: planNewApp({ name: FIXTURE_APP, example: false }),
  },
  // One per shape: each overlay drops, edits and adds files no other invocation writes.
  ...NEW_SHAPES.map(
    (shape): ScaffoldVariant => ({
      name: `x new --shape ${shape}`,
      why: `the ${shape} overlay (templates/shapes/${shape}.ts) over the scaffold it starts from`,
      files: planNewApp({ name: FIXTURE_APP, example: true, shape }),
    }),
  ),
];
