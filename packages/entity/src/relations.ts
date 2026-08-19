// The relations an entity already declared. A `.references(() => orgs.id)` is a foreign key AND
// an association; reading it as both is what lets a preload exist with no second declaration
// syntax to keep in sync with the first — the FK already written IS the relation.
//
// Derivation, plus the one place that reads the registry for it: a `hasMany` is a fact about the
// whole set, and no single entity can see the foreign keys pointing AT it. How an edge is
// traversed is a separate decision, made by its own caller.
//
// The edges come in already resolved, as `RegistryEntry.references()` records. Nothing here
// parses `describe()`'s `"<table>.<column>"` rendering: that string carries physical names only,
// and a traversal reads row properties.

import { invariantViolated, preloadUnknownRelation } from './errors';
import type { ReferenceDescription, RegistryEntry } from './registry';
import { registeredEntities, registryGeneration } from './registry';

export type RelationKind = 'belongsTo' | 'hasMany';

/**
 * One edge, read from one side. `local` is always a property of `from` and `remote` always a
 * property of `to`, whichever way the edge is being read — so a traversal is one sentence in both
 * directions: collect `localKey` off the rows in hand, then ask `to` for the rows whose
 * `remoteColumn` is in that set.
 */
export interface Relation {
  readonly kind: RelationKind;
  /** Unique within `from`. This is the name a preload names. */
  readonly name: string;
  /** The entity the relation hangs off — the side holding the rows you already have. */
  readonly from: string;
  /** The entity the related rows come from. May be outside the set the map was built over. */
  readonly to: string;
  readonly localKey: string;
  readonly localColumn: string;
  readonly remoteKey: string;
  readonly remoteColumn: string;
  /** The FK column is nullable, so a `belongsTo` resolving to nothing is data, not a broken FK. */
  readonly nullable: boolean;
}

/** Every relation reachable from one entity, by name. ONE flat namespace across both kinds. */
export type EntityRelations = Readonly<Record<string, Relation>>;

/** Keyed by entity name, in sorted order — a projection is a build input and must diff cleanly. */
export type RelationMap = Readonly<Record<string, EntityRelations>>;

interface ForeignKey extends ReferenceDescription {
  /** The entity that declared `references()`. Never the target. */
  readonly entity: string;
}

interface Candidate {
  /** Taken when nothing else in this entity wants it. */
  readonly preferred: string;
  /** Taken by EVERY member of a group whose `preferred` collides — never by one of them. */
  readonly fallback: string;
  readonly relation: Omit<Relation, 'name'>;
}

const ID_SUFFIX = 'Id';

/** `authorId` -> `author`: the FK's own name, minus the part that only says "this is a key". */
const withoutId = (property: string): string =>
  property.length > ID_SUFFIX.length && property.endsWith(ID_SUFFIX)
    ? property.slice(0, -ID_SUFFIX.length)
    : property;

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

const foreignKeysOf = (entry: RegistryEntry): readonly ForeignKey[] =>
  entry.references().map((reference) => ({ entity: entry.name, ...reference }));

const belongsTo = (fk: ForeignKey): Candidate => ({
  preferred: withoutId(fk.property),
  fallback: fk.property,
  relation: {
    kind: 'belongsTo',
    from: fk.entity,
    to: fk.targetEntity,
    localKey: fk.property,
    localColumn: fk.column,
    remoteKey: fk.targetProperty,
    remoteColumn: fk.targetColumn,
    nullable: fk.nullable,
  },
});

const hasMany = (fk: ForeignKey): Candidate => ({
  preferred: fk.entity,
  fallback: `${fk.entity}By${capitalize(withoutId(fk.property))}`,
  relation: {
    kind: 'hasMany',
    from: fk.targetEntity,
    to: fk.entity,
    localKey: fk.targetProperty,
    localColumn: fk.targetColumn,
    remoteKey: fk.property,
    remoteColumn: fk.column,
    nullable: fk.nullable,
  },
});

/** Where the FK is written, whichever side the relation is read from — what a rename must edit. */
const declaredAt = (relation: Omit<Relation, 'name'>): string =>
  relation.kind === 'belongsTo'
    ? `${relation.from}.${relation.localKey}`
    : `${relation.to}.${relation.remoteKey}`;

/**
 * Two tiers, and the second is taken by the whole colliding group rather than by the newcomer:
 * whether `posts` keeps its name must not depend on which foreign key was declared first.
 *
 * The tiers resolve every realistic schema. Within one group a `belongsTo` falls back to its own
 * property (`author` or `authorId`) and a `hasMany` to `<source>By<Fk>`, which cannot be equal;
 * two `belongsTo` differ by property and two `hasMany` share a source, so they differ by FK. What
 * survives is a name a THIRD group also kept, or two FKs on one entity whose names differ only by
 * an `Id` suffix — both are one rename away, and both are refused rather than silently collapsed
 * into one relation.
 */
const named = (entityName: string, candidates: readonly Candidate[]): EntityRelations => {
  const wanted = new Map<string, number>();
  for (const candidate of candidates) {
    wanted.set(candidate.preferred, (wanted.get(candidate.preferred) ?? 0) + 1);
  }
  const relations = new Map<string, Relation>();
  for (const candidate of candidates) {
    const contested = (wanted.get(candidate.preferred) ?? 0) > 1;
    const name = contested ? candidate.fallback : candidate.preferred;
    const taken = relations.get(name);
    if (taken !== undefined) {
      throw invariantViolated(
        entityName,
        'relations',
        `${declaredAt(taken)} and ${declaredAt(candidate.relation)} both resolve to the relation ` +
          `"${name}" — rename one of the two columns`,
      );
    }
    relations.set(name, { ...candidate.relation, name });
  }
  return Object.fromEntries([...relations].sort(([a], [b]) => (a < b ? -1 : 1)));
};

/**
 * Every relation among these entities, keyed by entity name.
 *
 * A `belongsTo` is a fact about the entity's own column, so it is recorded even when its target
 * is outside the set — the caller resolves `to` when it traverses. A `hasMany` is a fact about a
 * pair, so only the inbound keys of entities that were passed in can produce one.
 */
export const relationsOf = (entries: readonly RegistryEntry[]): RelationMap => {
  // By name: the registry already refuses two entities with one name, so the same entry handed
  // in twice is one entity — not two sets of foreign keys colliding with themselves.
  const unique = new Map(entries.map((entry) => [entry.name, entry]));
  // One pass, filed under both ends as it goes. Rescanning every foreign key once per entity is
  // the whole schema squared, paid again on the first read after every late registration.
  const outbound = new Map<string, Candidate[]>();
  const inbound = new Map<string, Candidate[]>();
  for (const name of unique.keys()) {
    outbound.set(name, []);
    inbound.set(name, []);
  }
  for (const entry of unique.values()) {
    for (const fk of foreignKeysOf(entry)) {
      outbound.get(fk.entity)?.push(belongsTo(fk));
      // A target outside the set contributes no `hasMany`: nothing here holds its inbound keys.
      inbound.get(fk.targetEntity)?.push(hasMany(fk));
    }
  }
  const map: Record<string, EntityRelations> = {};
  for (const name of [...unique.keys()].sort()) {
    // Outbound before inbound, so a collision resolves the same way whichever pass found it.
    map[name] = named(name, [...(outbound.get(name) ?? []), ...(inbound.get(name) ?? [])]);
  }
  return map;
};

/** Rebuilt on the first read after any registration, never on a read that changed nothing. */
let cached: { readonly generation: number; readonly map: RelationMap } | undefined;

/**
 * The relations of every registered entity — the set query time means by "the relations".
 *
 * Memoised against the registry generation rather than computed once: a schema module imported
 * after the first read registers one more entity, and a `hasMany` that entity contributes would
 * otherwise be missing for the rest of the process. Deriving costs one pass over the foreign keys,
 * so a read that follows a registration simply pays it again.
 */
export const relationMap = (): RelationMap => {
  const generation = registryGeneration();
  if (cached !== undefined && cached.generation === generation) return cached.map;
  const map = relationsOf(registeredEntities());
  cached = { generation, map };
  return map;
};

/** Every relation reachable from one entity. An unregistered name has none — that is not an error. */
export const relationsFor = (entityName: string): EntityRelations =>
  relationMap()[entityName] ?? {};

/**
 * One relation, by the name a caller wrote. A preload names its relation as a *string*, so an
 * unknown one is only actionable if the refusal carries the names that do exist — and they exist
 * nowhere to go and read, being derived from `references()` rather than declared.
 */
export const relationNamed = (entityName: string, name: string): Relation => {
  const relations = relationsFor(entityName);
  // `relations[name]` walks the prototype: `preload('toString')` used to hand back
  // `Function.prototype.toString` AS a `Relation`, past the refusal, to be read for a `.through`
  // it does not have. A relation map is derived from foreign keys, so a name is caller data here.
  const relation = Object.hasOwn(relations, name) ? relations[name] : undefined;
  if (relation === undefined) {
    throw preloadUnknownRelation(entityName, name, Object.keys(relations));
  }
  return relation;
};
