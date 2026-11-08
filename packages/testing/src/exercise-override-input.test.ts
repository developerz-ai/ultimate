// `overrideInput`: the bound input moves with its re-homed actor, so the org an entry declared is
// the tenant the pass seated it in — and nothing else in the input is touched.

import { describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import { overrideInput } from './exercise-override-input';
import { testName } from './test-types';

const DECLARED = '00000000-0000-4000-8000-000000000002';
const TENANT = '00000000-0000-4000-8000-0000000000aa';
const entry = {
  actor: userActor({ id: 'member', orgId: DECLARED, permissions: ['post:write'] }),
  input: (drawn: Readonly<Record<string, unknown>>) => ({ ...drawn, orgId: DECLARED }),
};

describe(testName('unit', 'an override input, re-homed'), () => {
  test('the declared org becomes the tenant the actor was seated in', async () => {
    const bind = overrideInput('archivePost', entry);
    const seatedActor = userActor({ id: 'member', orgId: TENANT, permissions: ['post:write'] });
    expect(await bind?.({ id: 'p1', note: DECLARED.slice(1) }, seatedActor)).toEqual({
      id: 'p1',
      note: DECLARED.slice(1),
      orgId: TENANT,
    });
  });

  test('an actor still in the declared org leaves the input as bound', async () => {
    const bind = overrideInput('archivePost', entry);
    expect(await bind?.({ id: 'p1' }, entry.actor)).toEqual({ id: 'p1', orgId: DECLARED });
  });
});
