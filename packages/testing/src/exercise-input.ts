// The input one exercise run sends: 39's minimal draw (`@ultimat3/schema/sample`, the one schema
// walker), then every id field whose stem names a seeded entity bound to a row of the actor's own
// tenant (`postId` -> `posts`), then the app's override. A wrong guess is visible as `unreached`.

import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { SeedGraph } from './seed-graph-plan';
import type { SeedEntity } from './seed-graph-shape';

/** The two draws 39 ships: the minimal value, and a seeded one for every later run. */
export interface Sampler {
  sampleInput(schema: StandardSchemaV1): unknown;
  arbitrary(schema: StandardSchemaV1, options: { seed: number; run: number }): unknown;
  /** The fields the minimal draw cannot fill, and what each needs: a drift's hint names them. */
  sampleGaps(schema: StandardSchemaV1): readonly string[];
  describeSampleGap(schema: StandardSchemaV1, path: string): string;
}

/** On demand: a `packages/core` test that never exercises anything must not load the walker. */
export const loadSampler = async (): Promise<Sampler> => import('@ultimat3/schema/sample');

/** Run 0 is the minimal draw; a run an override asked for beyond it is 39's seeded draw. */
export const drawInput = (sampler: Sampler, schema: StandardSchemaV1, seed: number, run: number) =>
  run === 0 ? sampler.sampleInput(schema) : sampler.arbitrary(schema, { seed, run });

/** `postId`, `post_id` -> `post`; `id` alone names no entity. */
export function idStem(key: string): string | undefined {
  const match = /^(.+?)_?(?:Id|_id|ID)$/.exec(key);
  return match?.[1] === undefined || match[1].length === 0 ? undefined : match[1];
}

/** Case and separators dropped: `blogPost` and `blog_posts` meet at `blogpost`/`blogposts`. */
const folded = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '');

const pluralsOf = (stem: string): readonly string[] => {
  const base = folded(stem);
  return [base, `${base}s`, `${base}es`, base.endsWith('y') ? `${base.slice(0, -1)}ies` : base];
};

/**
 * The entity a stem names, by its declared name or its table, singular or plural — exactly, or
 * else as the one entity whose name ENDS with it (`endpointId` -> `webhook_endpoints`). Two
 * suffix matches name nothing: a guess between two tables is not a binding.
 */
export function entityForStem(
  stem: string,
  entities: readonly SeedEntity[],
): SeedEntity | undefined {
  const wanted = pluralsOf(stem);
  const names = (entity: SeedEntity): readonly string[] => [
    folded(entity.$name),
    folded(entity.$table),
  ];
  const exact = entities.find((entity) => names(entity).some((name) => wanted.includes(name)));
  if (exact !== undefined) return exact;
  const suffixed = entities.filter((entity) =>
    names(entity).some((name) => wanted.some((form) => name.endsWith(form))),
  );
  return suffixed.length === 1 ? suffixed[0] : undefined;
}

/**
 * The id an `<stem>Id` field takes: the key of a seeded row of that entity the tenant sees — one
 * that references the actor when there is one (`authorId` = the actor), since ownership is the
 * rule a handler most often checks; else one that is not the actor's own row.
 */
export type IdLookup = (
  key: string,
) => { readonly found: true; readonly value: unknown } | undefined;

const singularOf = (name: string): string =>
  name.endsWith('ies') ? `${name.slice(0, -3)}y` : name.endsWith('s') ? name.slice(0, -1) : name;

/**
 * A bare `id` names the entity the PRIMITIVE is named after (`movePostStatus` -> `posts`): the
 * longest singular entity name inside the primitive's own name. A tie is no binding.
 */
export function entityForSubject(
  subject: string,
  entities: readonly SeedEntity[],
): SeedEntity | undefined {
  const name = folded(subject);
  const named = entities
    .map((entity) => [entity, singularOf(folded(entity.$name))] as const)
    .filter(([, singular]) => singular.length > 0 && name.includes(singular))
    .sort((a, b) => b[1].length - a[1].length);
  const [first, second] = named;
  return first === undefined || second?.[1].length === first[1].length ? undefined : first[0];
}

export interface IdScope {
  readonly tenant: string;
  /** The acting row's id: a row referencing it is preferred. */
  readonly actorId?: string | undefined;
  /** The primitive's name, for a bare `id`. */
  readonly subject: string;
  /** The entity whose rows are the actors (`defineExercise(…, { actor })`). */
  readonly actorEntity?: string | undefined;
  /**
   * For a field naming the actor entity itself: the actor's OWN row (`memberId` on a preference)
   * or somebody else's (`userId` on a block). Both are legitimate, so the pass tries each.
   */
  readonly self?: boolean;
}

/** The entity an input key names, if any: `<stem>Id`, or a bare `id` by the primitive's name. */
const entityForField = (
  key: string,
  entities: readonly SeedEntity[],
  subject: string,
): SeedEntity | undefined => {
  if (key === 'id') return entityForSubject(subject, entities);
  const stem = idStem(key);
  return stem === undefined ? undefined : entityForStem(stem, entities);
};

/** Whether any string field of the drawn value names the actor entity — a two-run input. */
export function namesActorEntity(
  drawn: unknown,
  entities: readonly SeedEntity[],
  scope: Pick<IdScope, 'subject' | 'actorEntity'>,
): boolean {
  if (scope.actorEntity === undefined || !isPlainObject(drawn)) return false;
  return Object.keys(drawn).some((key) =>
    typeof drawn[key] === 'string'
      ? entityForField(key, entities, scope.subject)?.$name === scope.actorEntity
      : namesActorEntity(drawn[key], entities, scope),
  );
}

export function seededIds(
  graph: SeedGraph,
  entities: readonly SeedEntity[],
  scope: IdScope,
): IdLookup {
  const { tenant, actorId } = scope;
  // A tenant column's own field (`orgId`) is the tenant the actor stands in, whatever entity it
  // happens to name: a policy comparing it with `actor.orgId` refuses any other id.
  const tenantKeys = new Set(entities.map((entity) => entity.$tenantColumn));
  return (key) => {
    if (tenantKeys.has(key)) return { found: true, value: tenant };
    const entity = entityForField(key, entities, scope.subject);
    if (entity === undefined || entity.$primaryKey.length !== 1) return undefined;
    const property = entity.$primaryKey[0] as string;
    const seen = graph.inserts.filter(
      (insert) =>
        insert.entity === entity.$name && (insert.tenant === null || insert.tenant === tenant),
    );
    const own = (insert: (typeof seen)[number]) => insert.row[property] === actorId;
    const references = (insert: (typeof seen)[number]) =>
      !own(insert) && Object.values(insert.row).includes(actorId);
    const other = seen.find((insert) => !own(insert));
    // The actor entity itself: the actor's own row on the `self` run, somebody else's otherwise.
    // Any other entity: a row the actor owns (`authorId`) first, then anyone but the actor.
    const row =
      actorId === undefined
        ? seen[0]
        : entity.$name === scope.actorEntity
          ? scope.self === true
            ? (seen.find(own) ?? seen[0])
            : (other ?? seen[0])
          : (seen.find(references) ?? other ?? seen[0]);
    return row === undefined ? undefined : { found: true, value: row.row[property] };
  };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
};

/**
 * The drawn value with every id field bound, at any depth of plain objects. A walk of the VALUE,
 * not the schema: the draw already decided which keys exist. Own keys only, into a fresh object.
 */
export function bindIds(drawn: unknown, lookup: IdLookup): unknown {
  if (Array.isArray(drawn)) return drawn.map((item) => bindIds(item, lookup));
  if (!isPlainObject(drawn)) return drawn;
  const bound: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(drawn)) {
    const hit = typeof drawn[key] === 'string' ? lookup(key) : undefined;
    bound[key] = hit === undefined ? bindIds(drawn[key], lookup) : hit.value;
  }
  return bound;
}
