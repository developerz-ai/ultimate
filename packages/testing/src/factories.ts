// Typed factories over an entity: FactoryBot's strategies, traits, transients, callbacks,
// inheritance and associations, with seeded values so two runs of a suite produce byte-identical
// rows. The row pipeline is `factory-pipeline.ts`; this file holds the sequence and the strategies.

import { fnv1a } from '@ultimat3/core';
import { seededRandom, seededUuid } from './determinism';
import { FactoryTraitUnknownError } from './errors';
import type { Factory, FactoryExtension, FactoryOptions } from './factory-api';
import { persistRow } from './factory-persist';
import { attributesOf, type FactorySpec, rowSteps, type Step } from './factory-pipeline';
import type {
  BelongsToMap,
  DefaultsBound,
  EntityLike,
  FactoryIds,
  HasManyMap,
  None,
  SettledAttrs,
  StoredOf,
  TraitMap,
} from './factory-types';

/**
 * Two factories with the same seed emit the same uuids, so a default of `1` everywhere gave a user
 * and a post the same id — rows that only look related. Core's FNV-1a over the table name keeps
 * every table on its own stream while staying a pure function of the schema.
 */
export function seedFor(table: string): number {
  const hash = fnv1a(table);
  return hash === 0 ? 1 : hash;
}

/** One factory's sequence, shared by every `with()` view and `extend()` child of it. */
interface Sequence {
  index: number;
  uuid: () => string;
  random: () => number;
  readonly ids: FactoryIds;
  resetting: boolean;
}

/** Every sequence ever declared: `factorySeed` restarts them all so a replay draws the same ids. */
const sequences = new Set<{ readonly sequence: Sequence; readonly seed: number }>();

export function resetFactorySequences(): void {
  for (const { sequence, seed } of sequences) restart(sequence, seed);
}

const restart = (sequence: Sequence, seed: number): void => {
  sequence.uuid = seededUuid(seed);
  sequence.random = seededRandom(seed);
  sequence.index = 0;
};

const drive = (steps: Generator<Step, object, unknown>): object => {
  let next = steps.next();
  while (next.done !== true) {
    const step = next.value;
    // `build()` yields only parents and children: no write and no `afterCreate` is ever asked for.
    next = steps.next(
      step.kind === 'parent' || step.kind === 'child' ? step.factory.build(step.over) : undefined,
    );
  }
  return next.value;
};

const driveAsync = async (
  entity: EntityLike,
  steps: Generator<Step, object, unknown>,
): Promise<object> => {
  let next = steps.next();
  while (next.done !== true) {
    const step = next.value;
    // Sequential, never `Promise.all`: two parents made at once would interleave their draws from
    // the seeded generators and the run would stop being reproducible.
    const answer =
      step.kind === 'persist'
        ? await persistRow(entity, step.row)
        : step.kind === 'callback'
          ? await step.run()
          : await step.factory.create(step.over);
    next = steps.next(answer);
  }
  return next.value;
};

type RuntimeFactory = Factory<object, string, object, object, unknown, unknown>;

function view(
  spec: FactorySpec,
  sequence: Sequence,
  seed: number,
  applied: readonly string[],
): RuntimeFactory {
  const declared = Object.keys(spec.traits).sort();
  const next = (): { index: number; ids: FactoryIds } => {
    sequence.index += 1;
    return { index: sequence.index, ids: sequence.ids };
  };
  // `Object.hasOwn`, not `traits[name] === undefined`: the plain read walked the prototype chain,
  // so `with('toString')` applied `Object.prototype.toString` and spread its string into a row.
  const assertTrait = (name: string): string => {
    if (!Object.hasOwn(spec.traits, name)) {
      throw new FactoryTraitUnknownError({ table: spec.entity.$table, trait: name, declared });
    }
    return name;
  };
  const build = (over: object = {}): object =>
    drive(rowSteps(spec, applied, over, 'build', next()));
  const create = (over: object = {}): Promise<object> =>
    driveAsync(spec.entity, rowSteps(spec, applied, over, 'create', next()));
  return {
    entity: spec.entity,
    table: spec.entity.$table,
    traits: declared,
    build,
    buildList: (count, over = {}) => Array.from({ length: count }, () => build(over)),
    create,
    createList: async (count, over = {}) => {
      const rows: object[] = [];
      for (let i = 0; i < count; i += 1) rows.push(await create(over));
      return rows;
    },
    attributesFor: (over = {}) => attributesOf(spec, applied, over, next()),
    // Checked here rather than at build time: `with()` is the line that named the trait.
    with: (...names) => view(spec, sequence, seed, [...applied, ...names.map(assertTrait)]),
    // Erased like every view, and `extend` is generic in what it adds: no erased value names
    // `TMoreTraits`/`TMoreMany`, so the cast is to `never` — `Factory.extend`'s signature states them.
    extend: (extension) => view(extended(spec, extension), sequence, seed, applied) as never,
    reset: () => {
      // A cycle (post hasMany comments, comment belongsTo post) would reset forever.
      if (sequence.resetting) return;
      sequence.resetting = true;
      try {
        restart(sequence, seed);
        // A half-reset row — own columns replayed, a fresh parent id — is worse than no reset.
        for (const [, link] of spec.belongsTo) link.parent.reset();
        for (const [, link] of spec.hasMany) link.child.reset();
      } finally {
        sequence.resetting = false;
      }
    },
  };
}

/** The child spec: defaults over the parent's, traits and transients merged, callbacks chained. */
function extended(
  spec: FactorySpec,
  extension: FactoryExtension<object, unknown, object, object, unknown, unknown>,
): FactorySpec {
  const { defaults, afterBuild, afterCreate } = extension;
  return {
    ...spec,
    defaults: (index, ids, transient) => ({
      ...spec.defaults(index, ids, transient),
      ...defaults?.(index, ids, transient),
    }),
    traits: { ...spec.traits, ...(extension.traits as FactorySpec['traits'] | undefined) },
    transient: { ...spec.transient, ...extension.transient },
    hasMany: [...spec.hasMany, ...Object.entries((extension.hasMany ?? {}) as HasManyMap)],
    afterBuild: afterBuild === undefined ? spec.afterBuild : [...spec.afterBuild, afterBuild],
    afterCreate: afterCreate === undefined ? spec.afterCreate : [...spec.afterCreate, afterCreate],
  };
}

export function defineFactory<
  TAttrs extends DefaultsBound<TAttrs, E>,
  E extends EntityLike = EntityLike,
  TTransient extends object = None,
  TTraits extends TraitMap<
    SettledAttrs<TAttrs> & StoredOf<E, SettledAttrs<TAttrs>>,
    TTransient
  > = TraitMap<SettledAttrs<TAttrs> & StoredOf<E, SettledAttrs<TAttrs>>, TTransient>,
  TBelongs extends BelongsToMap = None,
  TMany extends HasManyMap = None,
>(
  entity: E,
  options: FactoryOptions<
    TAttrs,
    TTraits,
    TTransient,
    TBelongs,
    TMany,
    StoredOf<E, SettledAttrs<TAttrs>>,
    E
  >,
): Factory<
  SettledAttrs<TAttrs>,
  Extract<keyof TTraits, string>,
  StoredOf<E, SettledAttrs<TAttrs>>,
  TTransient,
  TBelongs,
  TMany
> {
  const seed = options.seed ?? seedFor(entity.$table);
  const sequence: Sequence = {
    index: 0,
    uuid: seededUuid(seed),
    random: seededRandom(seed),
    ids: { uuid: () => sequence.uuid(), number: () => Math.floor(sequence.random() * 1_000_000) },
    resetting: false,
  };
  sequences.add({ sequence, seed });
  // Erased once, here: the public options held each member to its own column's type already.
  const erased = options as unknown as FactoryOptions<
    object,
    unknown,
    object,
    unknown,
    unknown,
    object
  >;
  const spec: FactorySpec = {
    entity,
    defaults: (index, ids, transient) => erased.defaults(index, ids, transient),
    traits: (options.traits ?? {}) as FactorySpec['traits'],
    transient: (options.transient ?? {}) as FactorySpec['transient'],
    belongsTo: Object.entries((options.belongsTo ?? {}) as BelongsToMap),
    hasMany: Object.entries((options.hasMany ?? {}) as HasManyMap),
    afterBuild: erased.afterBuild === undefined ? [] : [erased.afterBuild.bind(options)],
    afterCreate: erased.afterCreate === undefined ? [] : [erased.afterCreate.bind(options)],
  };
  return view(spec, sequence, seed, []) as unknown as Factory<
    SettledAttrs<TAttrs>,
    Extract<keyof TTraits, string>,
    StoredOf<E, SettledAttrs<TAttrs>>,
    TTransient,
    TBelongs,
    TMany
  >;
}
