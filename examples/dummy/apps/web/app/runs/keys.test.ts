// A run key: the scopes it is cut by, whose it is, and that the mount's resolver answers every
// bad token with the same `null`. The store and the resolver themselves are `@ultimat3/auth`'s.
import { frozenClock } from '@ultimat3/core';
import { expect, unitTest } from '@ultimat3/testing';
import {
  issueRunKeyFor,
  RUN_KEY_SCOPES,
  resolveRunKey,
  revokeRunKeyById,
  runKeyOwner,
} from './keys';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const clock = frozenClock('2026-10-01T09:00:00.000Z');

unitTest('the scope map names the three run actions and the live query', () => {
  expect(RUN_KEY_SCOPES['run:write']).toEqual(['startRun', 'answerPrompt', 'cancelRun']);
  expect(RUN_KEY_SCOPES['run:read']).toEqual(['liveRunEvents']);
});

unitTest('an issued key carries both scopes, belongs to its org and resolves', async () => {
  const issued = await issueRunKeyFor({ orgId: ORG, userId: 'ada', clock });
  expect(issued.key.startsWith('ult_dev_')).toBe(true);
  expect(await runKeyOwner(issued.id)).toEqual({ orgId: ORG });
  expect(await runKeyOwner('nobody')).toBeNull();
  const caller = await resolveRunKey(issued.key);
  expect(caller?.actor.kind).toBe('agent');
  expect(caller?.scopes.has('run:write')).toBe(true);
});

unitTest(
  'every bad token is the same null: malformed, unknown, wrong secret, revoked',
  async () => {
    const issued = await issueRunKeyFor({ orgId: ORG, userId: 'ada', clock });
    expect(await resolveRunKey('not a key')).toBeNull();
    expect(await resolveRunKey('ult_dev_0000000000000000_secret')).toBeNull();
    expect(await resolveRunKey(`${issued.prefix}_wrong`)).toBeNull();
    expect(await revokeRunKeyById(issued.id, clock)).toBe(true);
    expect(await resolveRunKey(issued.key)).toBeNull();
  },
);
