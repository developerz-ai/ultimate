// The factory lint: every factory, bare and with each trait alone, built AND created against its own
// entity — `$parse` and the invariants judge the built row, a throwaway memory driver the created
// one. What a test would have found one failure at a time, found at once.

import { isUltimateError, renderCauseValue, stringField } from '@ultimat3/core';
import type { AnyFactory } from './factory-api';
import { type FactoryFinding, FactoryInvalidError } from './factory-errors';
import { entityPersister, isEntity, swapPersister } from './factory-persist';
import type { EntityLike } from './factory-types';

/** The factories to judge, keyed by the name a finding reports. */
export type FactorySet = Readonly<Record<string, AnyFactory>>;

const findingOf = (
  where: Pick<FactoryFinding, 'factory' | 'trait' | 'strategy'>,
  error: unknown,
): FactoryFinding => ({
  ...where,
  code: isUltimateError(error) ? error.code : 'X_TEST_FACTORY_INVALID',
  cause: stringField(error, 'cause') ?? stringField(error, 'message') ?? renderCauseValue(error),
});

/** A built key the entity declares no column for: `$parse` would drop it, and the test with it. */
const unknownColumns = (entity: EntityLike, row: object): readonly string[] =>
  Object.keys(row).filter((key) => !Object.hasOwn(entity.$columns, key));

/** Build, judge, create; each failure a finding, never a throw. */
async function judge(
  factory: AnyFactory,
  where: Pick<FactoryFinding, 'factory' | 'trait'>,
): Promise<readonly FactoryFinding[]> {
  const findings: FactoryFinding[] = [];
  const { entity } = factory;
  try {
    const row = factory.build();
    const extra = unknownColumns(entity, row);
    if (extra.length > 0) {
      findings.push({
        ...where,
        strategy: 'build',
        code: 'X_TEST_FACTORY_INVALID',
        cause: `${entity.$table} declares no column ${extra.join(', ')}`,
      });
    }
    if (isEntity(entity)) entity.$assert(entity.$parse(row));
  } catch (error: unknown) {
    findings.push(findingOf({ ...where, strategy: 'build' }, error));
  }
  try {
    await factory.create();
  } catch (error: unknown) {
    findings.push(findingOf({ ...where, strategy: 'create' }, error));
  }
  return findings;
}

/**
 * Every factory and every trait of it, each from a restarted sequence into its OWN fresh memory
 * driver: one shared driver made the second factory's org repeat the first's key — a finding about
 * the lint, not the factory. The app's rows are never touched, and the sequences are restarted
 * after, so a lint run leaves no trace on the suite.
 */
export async function lintFactories(factories: FactorySet): Promise<readonly FactoryFinding[]> {
  const { memoryDriver } = await import('@ultimat3/entity');
  const previous = swapPersister(undefined);
  const findings: FactoryFinding[] = [];
  const isolated = async (
    factory: AnyFactory,
    where: Pick<FactoryFinding, 'factory' | 'trait'>,
  ): Promise<void> => {
    factory.reset();
    swapPersister(entityPersister({ driver: memoryDriver() }));
    findings.push(...(await judge(factory, where)));
  };
  try {
    for (const [name, factory] of Object.entries(factories)) {
      await isolated(factory, { factory: name, trait: null });
      for (const trait of factory.traits)
        await isolated(factory.with(trait), { factory: name, trait });
      factory.reset();
    }
  } finally {
    swapPersister(previous);
  }
  return findings;
}

/** `lintFactories`, as one coded failure listing every finding: `X_TEST_FACTORY_INVALID`. */
export async function assertFactoriesValid(factories: FactorySet): Promise<void> {
  const [first, ...rest] = await lintFactories(factories);
  if (first !== undefined) throw new FactoryInvalidError([first, ...rest]);
}
