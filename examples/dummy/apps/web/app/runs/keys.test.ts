// A run key: the scopes it is cut by, whose it is, and that the mount's resolver answers every
// bad token with the same `null`. The store and the resolver themselves are `@ultimat3/auth`'s.
import { frozenClock } from '@ultimat3/core';
import { expect, unitTest } from '@ultimat3/testing';
import {
  issueOrgKeyFor,
  ORG_KEY_SCOPES,
  orgKeyOwner,
  resolveOrgKey,
  revokeOrgKeyById,
} from './keys';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const clock = frozenClock('2026-10-01T09:00:00.000Z');

unitTest('the scope map names the three run actions, the live query and publishing', () => {
  expect(ORG_KEY_SCOPES['run:write']).toEqual(['startRun', 'answerPrompt', 'cancelRun']);
  expect(ORG_KEY_SCOPES['run:read']).toEqual(['liveRunEvents']);
  expect(ORG_KEY_SCOPES['post:publish']).toEqual(['publishPost']);
});

unitTest('an issued key carries every scope, belongs to its org and resolves', async () => {
  const issued = await issueOrgKeyFor({ orgId: ORG, clock });
  expect(issued.key.startsWith('ult_dev_')).toBe(true);
  expect(await orgKeyOwner(issued.id)).toEqual({ orgId: ORG });
  expect(await orgKeyOwner('nobody')).toBeNull();
  const caller = await resolveOrgKey(issued.key);
  expect(caller?.actor.kind).toBe('agent');
  expect(caller?.scopes.has('run:write')).toBe(true);
  expect(caller?.scopes.has('post:publish')).toBe(true);
});

unitTest('a narrowed key carries only the scopes it was issued with', async () => {
  const issued = await issueOrgKeyFor({ orgId: ORG, clock, scopes: ['run:write'] });
  const caller = await resolveOrgKey(issued.key);
  expect([...(caller?.scopes ?? [])]).toEqual(['run:write']);
});

unitTest(
  'every bad token is the same null: malformed, unknown, wrong secret, revoked',
  async () => {
    const issued = await issueOrgKeyFor({ orgId: ORG, clock });
    expect(await resolveOrgKey('not a key')).toBeNull();
    expect(await resolveOrgKey('ult_dev_0000000000000000_secret')).toBeNull();
    expect(await resolveOrgKey(`${issued.prefix}_wrong`)).toBeNull();
    expect(await revokeOrgKeyById(issued.id, clock)).toBe(true);
    expect(await resolveOrgKey(issued.key)).toBeNull();
  },
);
