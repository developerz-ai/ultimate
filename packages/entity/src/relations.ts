// The relations an entity already declared. A `.references(() => orgs.id)` is a foreign key AND
// an association; reading it as both is what lets a preload exist with no second declaration
// syntax to keep in sync with the first — the FK already written IS the relation.
//
// Derivation only. This file names and shapes the edges; who collects the entities and who
// traverses an edge are separate decisions, made by their own callers.

import type { Binding } from './column';
import { referenceBinding, snake } from './column';
import type { EntityCore } from './entity';
import { invariantViolated } from './errors';

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

interface ForeignKey {
  /** The entity that declared `references()`. Never the target. */
  readonly entity: string;
  readonly property: string;
  readonly column: string;
  readonly nullable: boolean;
  readonly target: Binding;
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

const foreignKeysOf = (entity: EntityCore): readonly ForeignKey[] =>
  Object.entries(entity.$columns).flatMap(([property, column]) => {
    const meta = column.$meta;
    // Money is two physical columns, so `snake(property)` names neither of them. The DDL
    // projection drops a reference there for the same reason; a relation and a foreign-key
    // constraint must not disagree about which columns exist.
    if (meta.kind === 'money') return [];
    const target = referenceBinding(entity.$name, property, meta);
    if (target === null) return [];
    return [
      {
        entity: entity.$name,
        property,
        column: snake(property),
        nullable: !meta.notNull,
        target,
      },
    ];
  });

const belongsTo = (fk: ForeignKey): Candidate => ({
  preferred: withoutId(fk.property),
  fallback: fk.property,
  relation: {
    kind: 'belongsTo',
    from: fk.entity,
    to: fk.target.table,
    localKey: fk.property,
    localColumn: fk.column,
    remoteKey: fk.target.property,
    remoteColumn: fk.target.name,
    nullable: fk.nullable,
  },
});

const hasMany = (fk: ForeignKey): Candidate => ({
  preferred: fk.entity,
  fallback: `${fk.entity}By${capitalize(withoutId(fk.property))}`,
  relation: {
    kind: 'hasMany',
    from: fk.target.table,
    to: fk.entity,
    localKey: fk.target.property,
    localColumn: fk.target.name,
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
export const relationsOf = (entities: readonly EntityCore[]): RelationMap => {
  // By name: the registry already refuses two entities with one name, so the same entity handed
  // in twice is one entity — not two sets of foreign keys colliding with themselves.
  const unique = new Map(entities.map((entity) => [entity.$name, entity]));
  const keys = [...unique.values()].flatMap(foreignKeysOf);
  const map: Record<string, EntityRelations> = {};
  for (const name of [...unique.keys()].sort()) {
    map[name] = named(name, [
      ...keys.filter((fk) => fk.entity === name).map(belongsTo),
      ...keys.filter((fk) => fk.target.table === name).map(hasMany),
    ]);
  }
  return map;
};
