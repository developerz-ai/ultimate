/**
 * unit — the one statement in Postly that spans orgs, against the in-memory driver that shares its
 * tenancy guard with the Postgres one. `allDigestRecipients` is the digest fan-out's recipient
 * read: `members` is tenant-scoped and the fan-out has no single org, so the read is only legal
 * inside `crossTenant()` with an actor that proves `tenancy:cross`.
 */

import { expect, test } from 'bun:test';
import { db } from '@postly/db';
import { orgId as toOrgId } from '@postly/domain';
import { createContext, runWithContext } from '@ultimat3/core';
import { allDigestRecipients, digestRecipients } from './repo';

let issued = 0;
/** Distinct per call: the memory store is process-wide, so one test's rows must not answer another's. */
const nextId = (): string => {
  issued += 1;
  return `00000000-0000-4000-8000-${String(issued).padStart(12, '0')}`;
};

/** One opted-in member in a brand-new org, and the org id it landed in. */
const anOptedInMember = async (): Promise<string> => {
  const orgId = nextId();
  await db.members.insert({
    orgId,
    userId: nextId(),
    email: `member-${issued}@postly.dev`,
    name: `Member ${issued}`,
    digestOptIn: true,
  });
  return orgId;
};

/** What the worker hands a job body: a context, and an actor with no org until `tenant` says one. */
const inAJob = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithContext(createContext({ role: 'worker' }), fn);

test('the fan-out reads every org, and the cross-tenant scope is what allows it', async () => {
  const first = await anOptedInMember();
  const second = await anOptedInMember();

  const recipients = await inAJob(() => allDigestRecipients());
  const orgs = new Set(recipients.map((member) => member.orgId));

  expect(orgs.has(first)).toBe(true);
  expect(orgs.has(second)).toBe(true);
});

test('the same statement outside that scope is refused, which is what makes the scope the mechanism', async () => {
  await anOptedInMember();

  // The same read `allDigestRecipients` issues, minus the `crossTenant()` around it: a `members`
  // page naming no org. A tenant-columned entity has no other escape hatch, so this is the
  // control — if it ever stops throwing, the test above stops proving anything.
  await expect(
    inAJob(() => db.members.where({ digestOptIn: true }).all()),
  ).rejects.toBeUltimateError('X_TENANCY_ACTOR_ORG_REQUIRED');
});

test('a per-org read stays per-org: the scope is on the sweep, not on the feature', async () => {
  const orgId = await anOptedInMember();
  await anOptedInMember();

  // `digestRecipients` names its org, so it needs no scope and must not have inherited one.
  const recipients = await digestRecipients(toOrgId(orgId));

  expect(recipients).toHaveLength(1);
  expect(recipients[0]?.orgId).toBe(orgId);
});
