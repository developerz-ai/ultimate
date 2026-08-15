// What the scaffold drift gate compiles: every documented `x new` invocation, with every `x g`
// generator run on top of the one that carries an app. Separate from the compiler harness next to
// it, because "which scaffolds exist" is a fact about the CLI's surface, not about running `tsc`.

import type { GenerateOptions } from './cmd-generate';
import { dedupe, generate } from './cmd-generate';
import { planNewApp } from './cmd-new';
import type { GeneratedFile } from './templates';

/** The app the fixture scaffolds. Kebab, multi-word: single-word names hide casing bugs. */
export const FIXTURE_APP = 'ledger-demo';

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
  { kind: 'action', name: 'send-invoice', feature: 'invoice' },
  { kind: 'mutator', name: 'rename-invoice', feature: 'invoice' },
  { kind: 'query', name: 'invoice-search', feature: 'invoice' },
  { kind: 'query', name: 'invoice-feed', feature: 'invoice', live: true },
  { kind: 'job', name: 'sweep-invoices', feature: 'invoice' },
  { kind: 'backfill', name: 'reindex-invoices', feature: 'invoice' },
  { kind: 'task', name: 'nightly-sweep', feature: 'invoice' },
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
];

/** The whole scaffolded surface: a new app, then every generator run inside it. */
export function scaffoldFixture(): readonly GeneratedFile[] {
  return dedupe([
    ...planNewApp({ name: FIXTURE_APP, example: true }),
    ...FIXTURE_GENERATORS.flatMap((options) => generate(options)),
  ]);
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
];
