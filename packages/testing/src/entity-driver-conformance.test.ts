// The entity driver suite over `memoryDriver()` — the reference every other driver is held to —
// and over the toy `defineDriver` store, which declares no capability. Then the proof the suite can
// fail: a memory driver that writes a patch's `undefined` as NULL, the bug the suite exists for.

import { describe, expect, test } from 'bun:test';
import type { Driver, EntityCore, Repo } from '@ultimat3/entity';
import { memoryDriver } from '@ultimat3/entity';
import { DRIVER_CAPABILITIES, defineDriver } from '@ultimat3/entity/adapter';
import { ENTITY_DRIVER_CHECKS } from './entity-conformance-checks';
import { toyStore } from './entity-conformance-toy-fixture';
import type { EntityDriverSubject } from './entity-driver-conformance';
import { entityDriverConformance, runEntityDriverCheck } from './entity-driver-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe(testName('unit', 'the memory entity driver'), () => {
  behavesLike(entityDriverConformance, () => ({
    open: () => memoryDriver(),
    capabilities: DRIVER_CAPABILITIES,
    foreignKeys: false,
    history: true,
  }));
});

const toy: EntityDriverSubject = {
  open: () => defineDriver(toyStore()),
  capabilities: [],
  foreignKeys: false,
};

describe(testName('unit', 'a defineDriver store declaring no capability'), () => {
  behavesLike(entityDriverConformance, () => toy);
});

/** Every patch value spelled out, `undefined` as NULL: correct for every write that names one. */
const nullingUndefined = (): Driver => {
  const inner = memoryDriver();
  return {
    ...inner,
    repo: <Row>(entity: EntityCore<Row>): Repo<Row> => {
      const repo = inner.repo(entity);
      const spelled = (patch: object) =>
        Object.fromEntries(
          Object.entries(patch).map(([key, value]) => [key, value ?? null]),
        ) as never;
      return {
        ...repo,
        update: (id, patch, options) => repo.update(id, spelled(patch), options),
        updateWhere: (filter, patch, options) => repo.updateWhere(filter, spelled(patch), options),
      };
    },
  };
};

const broken: EntityDriverSubject = {
  open: () => nullingUndefined(),
  capabilities: DRIVER_CAPABILITIES,
  foreignKeys: false,
};

const named = (name: string) => {
  const check = ENTITY_DRIVER_CHECKS.find((each) => each.name === name);
  if (check === undefined) return expect.unreachable(`no check named ${name}`);
  return check;
};

describe(testName('unit', 'a driver that writes undefined as NULL fails conformance'), () => {
  test('it fails the undefined-is-absent checks and passes one that never patches', async () => {
    for (const name of [
      'update keeps a column the patch names as undefined',
      'updateWhere keeps a column the patch names as undefined',
    ]) {
      await expect(runEntityDriverCheck(named(name), broken)).rejects.toThrow();
    }
    await runEntityDriverCheck(
      named('a duplicate primary key is refused, not a silent replace'),
      broken,
    );
  });

  test('a store claiming a capability it lacks is found out, never skipped', async () => {
    const claims: EntityDriverSubject = {
      open: () => defineDriver(toyStore()),
      capabilities: ['aggregate:countBy'],
      foreignKeys: false,
    };
    const countBy = named(
      'countBy groups the visible rows of one tenant, in value order, absent never zero',
    );
    await expect(runEntityDriverCheck(countBy, claims)).rejects.toThrow();
  });
});
