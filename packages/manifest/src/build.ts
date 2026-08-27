// `buildManifest` — the generated facts, emitted from code.
//
// DETERMINISM IS THE WHOLE POINT. `x.manifest.json` is committed and diffed in review, so
// two builds of the same tree must produce identical bytes. That means:
//   - no timestamps, no git sha, no build counter, no hostname;
//   - every collection is sorted by a stable key before it is written, because `Map` and
//     `Set` iteration order is insertion order and insertion order depends on module load
//     order, which depends on the filesystem;
//   - object keys are written in a fixed order (see `emit.ts`), not `JSON.stringify` order;
//   - `buildId` is a content hash of the sorted body, so it changes if and only if a fact
//     changed.
// A manifest that churns on every build trains reviewers to ignore its diff, which defeats
// the entire mechanism.
//
// Sources are injected. Route facts come from `@ultimat3/render` and policy facts are
// assembled per app — both outside what this tier may import — so the CLI supplies them and
// this function stays pure and unit-testable.

import { canonicalJson } from '@ultimat3/core';
import type {
  ActionFact,
  EntityFact,
  ErrorCodeFact,
  JobFact,
  Manifest,
  PolicyFact,
  QueryFact,
  RouteFact,
  TaskFact,
} from './schema';
import { MANIFEST_VERSION } from './schema';

export interface ManifestSources {
  readonly app: { readonly name: string; readonly version: string };
  readonly routes?: readonly RouteFact[];
  readonly entities?: readonly EntityFact[];
  readonly actions?: readonly ActionFact[];
  readonly queries?: readonly QueryFact[];
  readonly jobs?: readonly JobFact[];
  readonly tasks?: readonly TaskFact[];
  readonly policies?: readonly PolicyFact[];
  readonly locales?: readonly string[];
  readonly errorCodes?: readonly ErrorCodeFact[];
}

export function buildManifest(sources: ManifestSources): Manifest {
  const routes = sortBy(sources.routes ?? [], (r) => r.url).map(normalizeRoute);
  const entities = sortBy(sources.entities ?? [], (e) => e.name).map(normalizeEntity);
  const actions = sortBy(sources.actions ?? [], (a) => a.name).map(normalizeAction);
  const queries = sortBy(sources.queries ?? [], (q) => q.name).map(normalizeQuery);
  const jobs = sortBy(sources.jobs ?? [], (j) => j.name).map(normalizeJob);
  const tasks = sortBy(sources.tasks ?? [], (t) => t.name).map((t) => ({
    ...t,
    enqueues: [...t.enqueues].sort(),
  }));
  const policies = sortBy(sources.policies ?? [], (p) => p.permission).map((p) => ({
    ...p,
    enforcedIn: [...p.enforcedIn].sort(),
  }));
  const errorCodes = sortBy(sources.errorCodes ?? [], (e) => `${e.package}:${e.code}`);

  // Derived, never declared twice: the permission list IS the set of policy permissions
  // plus anything an action asserts. Two lists that must agree eventually disagree.
  //
  // Read from `permissions`, never from `policy`. `policy` is a policy's LABEL — for a composite
  // it renders `and(post:publish, org:administer)`, which is not a permission and matches no
  // grant, so deriving from it published one fictional entry per composite rule and dropped the
  // real ones. Every non-trivial rule in a real app is a composite.
  const permissions = unique([
    ...policies.map((p) => p.permission),
    ...actions.flatMap((a) => a.permissions),
    ...queries.flatMap((q) => q.permissions),
  ]);

  const body = {
    manifestVersion: MANIFEST_VERSION,
    app: sources.app,
    routes,
    entities,
    actions,
    queries,
    jobs,
    tasks,
    policies,
    permissions,
    locales: [...(sources.locales ?? [])].sort(),
    errorCodes,
  };

  return { ...body, buildId: contentHash(body) };
}

/**
 * Content hash of the manifest body. Deliberately excludes `buildId` itself, and is taken over
 * `@ultimat3/core`'s `canonicalJson` — the same INJECTIVE form the diff compares on, so a fact
 * that changed cannot hash the same as the fact it replaced.
 *
 * This is a HASH, never the published document: `manifestJson` in `emit.ts` is what reaches disk,
 * and it is `JSON.stringify` with a fixed key order for exactly that reason.
 */
export function contentHash(body: Omit<Manifest, 'buildId'>): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(canonicalJson(body));
  return hasher.digest('hex').slice(0, 16);
}

function sortBy<T>(items: readonly T[], key: (item: T) => string): readonly T[] {
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

// Inner collections are sorted too: a reordered column list is a spurious diff.
// `revalidateTags` is an author-declared SET — the same kind of list as an action's
// `cacheInvalidates`, which has always been sorted here. Left in declaration order it was the one
// inner collection `buildManifest` did not normalise, so reordering `revalidate: [tag.b, tag.a]`
// in a route file churned `buildId` and emitted a spurious `routes.<url>.revalidateTags` change.
// `jobs[].steps` is the one deliberate exception, and says why above itself.
const normalizeRoute = (route: RouteFact): RouteFact =>
  route.revalidateTags === undefined
    ? route
    : // Spread, never assigned: `exactOptionalPropertyTypes` makes an explicit `undefined` a
      // different answer from an absent key, and `emit.ts` writes what it is given.
      { ...route, revalidateTags: [...route.revalidateTags].sort() };

const normalizeEntity = (entity: EntityFact): EntityFact => ({
  ...entity,
  columns: sortBy(entity.columns, (c) => c.name),
  invariants: [...entity.invariants].sort(),
});

// `permissions` is sorted here as well as by its producer: `ManifestSources` is a public input,
// so a caller assembling facts by hand must not be able to make two builds of one program differ.
const normalizeAction = (action: ActionFact): ActionFact => ({
  ...action,
  permissions: [...action.permissions].sort(),
  cacheInvalidates: [...action.cacheInvalidates].sort(),
});

const normalizeQuery = (query: QueryFact): QueryFact => ({
  ...query,
  permissions: [...query.permissions].sort(),
  cacheTags: [...query.cacheTags].sort(),
  // Conditional, not `?? []`: the fact is absent when the read declared nothing, and writing an
  // empty array would make every plain read carry a key that means the same as no key.
  ...(query.subscribes === undefined ? {} : { subscribes: [...query.subscribes].sort() }),
});

// Job steps keep their DECLARED order — a job's steps are a sequence, not a set, and
// sorting them would misrepresent the program.
const normalizeJob = (job: JobFact): JobFact => ({ ...job, steps: [...job.steps] });
