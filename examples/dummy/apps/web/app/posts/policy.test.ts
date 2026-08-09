/**
 * unit — no DB, no I/O, which is the whole point: these predicates are synchronous so a live
 * query can re-evaluate one per subscriber per change. Every surface runs exactly what is here.
 */

import { expect, test } from 'bun:test';
import { memberId, orgId } from '@postly/domain';
import { userActor } from '@ultimat3/core';
import { type Actor, evaluate } from '@ultimat3/policy';
// Roles are app state, installed by importing the leaf both surfaces already import. Without it
// every actor holds nothing and each case below would pass on the grant check instead of the rule.
import '@postly/web/shared/policies';
import { feedRead, type PostRow, postPublish } from './policy';

const ACME = orgId('00000000-0000-4000-8000-000000000001');
const TINTA = orgId('00000000-0000-4000-8000-000000000002');

const ADA = memberId('00000000-0000-4000-8000-00000000000a');
const BRUNO = memberId('00000000-0000-4000-8000-00000000000b');

const actor = (id: string, org: string, role: string): Actor =>
  userActor({ id, orgId: org, roles: [role] });

/** An `author` holds `post:publish`; a `reader` does not. Both are Acme members. */
const bruno = actor(BRUNO, ACME, 'author');
const ada = actor(ADA, ACME, 'owner');
const kenji = actor('00000000-0000-4000-8000-00000000000c', ACME, 'reader');
const mara = actor('00000000-0000-4000-8000-00000000000d', TINTA, 'owner');

const brunosPost: PostRow = { orgId: ACME, authorId: BRUNO };
const adasPost: PostRow = { orgId: ACME, authorId: ADA };
const tintasPost: PostRow = {
  orgId: TINTA,
  authorId: memberId('00000000-0000-4000-8000-00000000000e'),
};

const publish = (who: Actor | null, row: PostRow | null, org = ACME): boolean =>
  evaluate(postPublish, { actor: who, input: { orgId: org }, row }).allowed;

const read = (who: Actor | null, row: PostRow | null, org = ACME): boolean =>
  evaluate(feedRead, { actor: who, input: { orgId: org }, row }).allowed;

test('postPublish allows an author their own draft', () => {
  expect(publish(bruno, brunosPost)).toBe(true);
});

test('postPublish allows an org admin someone else’s draft', () => {
  // Owns-or-org-admin: the second half of the rule, and the reason it is not just `authorId ===`.
  expect(publish(ada, brunosPost)).toBe(true);
});

test('postPublish denies a same-org author a colleague’s draft', () => {
  // Bruno holds the grant and the tenancy matches — authorship is the only thing standing in the
  // way, so this is the case a fail-open row branch used to wave through.
  expect(publish(bruno, adasPost)).toBe(false);
});

test('postPublish denies when no row was loaded', () => {
  // The regression that mattered: `row === null` used to mean "nothing to object to", so any
  // same-org holder of `post:publish` could publish anyone's draft by reaching a surface that
  // passed no row. An absent fact is not a satisfied one.
  expect(publish(bruno, null)).toBe(false);
  expect(publish(ada, null)).toBe(false);
});

test('postPublish denies a post that belongs to another org', () => {
  // Actor and input agree on Acme; only the row disagrees. Tenancy in `input` cannot catch this.
  expect(publish(bruno, tintasPost)).toBe(false);
});

test('postPublish denies a role that never held the grant', () => {
  expect(publish(kenji, brunosPost)).toBe(false);
});

test('postPublish denies across the tenant boundary and denies nobody at all', () => {
  expect(publish(mara, tintasPost, TINTA)).toBe(true); // Mara at home
  expect(publish(mara, tintasPost, ACME)).toBe(false); // …asking about Acme
  expect(publish(null, brunosPost)).toBe(false);
});

test('feedRead still allows a null row, because subscribe genuinely has none', () => {
  // Deliberately NOT the same shape as postPublish. @ultimat3/realtime evaluates this once at
  // subscribe with `row: null` and again per delivered row; at subscribe the question is "may
  // this member read this org's feed", which membership answers on its own.
  expect(read(kenji, null)).toBe(true);
  expect(read(mara, null)).toBe(false);
});

test('feedRead drops a row that left the actor’s org mid-stream', () => {
  expect(read(kenji, brunosPost)).toBe(true);
  expect(read(kenji, tintasPost)).toBe(false);
});
