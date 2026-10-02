// The runs service below its actions: the one refusal no action reaches, because `cancelRun`'s
// policy already denies a run with no row before the handler runs.
import { driver } from '@postly/db';
import { createContext, runWithContext } from '@ultimat3/core';
import { testActor } from '@ultimat3/policy';
import { afterEach, expect, unitTest } from '@ultimat3/testing';
import { runsService } from './service';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const writer = testActor('writer', { orgId: ORG, permissions: ['run:write'] }).actor;

afterEach(() => {
  driver.reset?.();
});

unitTest('cancelling a run that has no row is refused by name, not by an undefined', async () => {
  const ctx = createContext({ actor: writer });
  const refused = await runWithContext(ctx, () =>
    runsService(ctx).cancel('00000000-0000-4000-8000-0000000000fe'),
  ).catch((error: unknown) => error);
  expect(refused).toBeUltimateError('X_RUN_NOT_FOUND');
});
