// `restoreModels()`: the catalogue put back EXACTLY — rows and ladder order — which
// `@ultimat3/testing`'s file boundary does, so one file's `registerModel` is no later file's model.

import { afterAll, expect, test } from 'bun:test';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import { modelIds, registeredModels, registerModel, restoreModels } from './models';

const inherited = registeredModels();
afterAll(() => restoreModels(inherited));
useFixtureModels();

test('a restore puts back exactly the snapshot, in ladder order, dropping later rows', () => {
  const snapshot = registeredModels();
  const base = registeredModels().find((spec) => spec.id === FIXTURE_MODEL);
  if (base === undefined) return expect.unreachable('the fixture registered no FIXTURE_MODEL');
  registerModel({ ...base, id: 'restore-late' });
  expect(modelIds()).toContain('restore-late');
  restoreModels(snapshot);
  expect(modelIds()).toEqual(snapshot.map((spec) => spec.id));
  expect(registeredModels()).toEqual(snapshot);
});
