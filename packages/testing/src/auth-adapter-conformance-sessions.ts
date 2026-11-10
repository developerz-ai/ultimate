// `SessionStore` and the org sweep, for `authAdapterConformance`: a delete answers whether THIS
// call removed the row (`rotateSession` claims the id with it), every revocation counts what it
// killed, and "before an instant" is strictly before.

import { expect } from 'bun:test';
import type { AuthSession } from '@ultimat3/auth';
import type { AuthAdapterCheck } from './auth-adapter-conformance-support';
import { idOf, seedUser } from './auth-adapter-conformance-support';

const T0 = Date.parse('2026-09-01T10:00:00.000Z');
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);
const DELETERS = 8;

const session = (owner: string, createdAt = at(0), lastSeenAt = createdAt): AuthSession => ({
  id: idOf('session'),
  userId: owner,
  tokenHash: 'digest-of-the-secret-half',
  createdAt,
  absoluteExpiresAt: at(86_400),
  lastSeenAt,
  ip: '203.0.113.7',
  userAgent: 'conformance',
  mfaSatisfied: false,
});

export const AUTH_ADAPTER_SESSION_CHECKS: readonly AuthAdapterCheck[] = [
  {
    name: 'a session round-trips, a patch moves only what it names, and nobody is null',
    async run({ adapter }) {
      const row = session(await seedUser(adapter));
      await adapter.createSession(row);
      expect(await adapter.getSession(row.id)).toEqual(row);
      const patched = await adapter.updateSession(row.id, {
        lastSeenAt: at(60),
        mfaSatisfied: true,
        ip: null,
      });
      expect(patched).toEqual({ ...row, lastSeenAt: at(60), mfaSatisfied: true, ip: null });
      expect(await adapter.getSession(idOf('nobody'))).toBeNull();
      expect(await adapter.updateSession(idOf('nobody'), { lastSeenAt: at(1) })).toBeNull();
    },
  },
  {
    name: `${DELETERS} concurrent deletes of one session: exactly one answers true`,
    async run({ adapter }) {
      const row = session(await seedUser(adapter));
      await adapter.createSession(row);
      const answers = await Promise.all(
        Array.from({ length: DELETERS }, () => adapter.deleteSession(row.id)),
      );
      expect(answers.filter(Boolean)).toHaveLength(1);
      expect(await adapter.getSession(row.id)).toBeNull();
    },
  },
  {
    name: 'listSessions answers one user’s sessions, most recently seen first',
    async run({ adapter }) {
      const [owner, other] = [await seedUser(adapter), await seedUser(adapter)];
      const older = session(owner, at(0), at(10));
      const newer = session(owner, at(0), at(20));
      await adapter.createSession(older);
      await adapter.createSession(newer);
      await adapter.createSession(session(other));
      expect((await adapter.listSessions(owner)).map((row) => row.id)).toEqual([
        newer.id,
        older.id,
      ]);
    },
  },
  {
    name: 'deleteOtherSessions keeps the one named and counts the rest; ForUser takes them all',
    async run({ adapter }) {
      const [owner, other] = [await seedUser(adapter), await seedUser(adapter)];
      const [keep, drop, untouched] = [session(owner), session(owner), session(other)];
      for (const row of [keep, drop, untouched]) await adapter.createSession(row);
      expect(await adapter.deleteOtherSessions(owner, keep.id)).toBe(1);
      expect([await adapter.getSession(keep.id), await adapter.getSession(drop.id)]).toEqual([
        keep,
        null,
      ]);
      expect(await adapter.deleteSessionsForUser(owner)).toBe(1);
      expect(await adapter.getSession(keep.id)).toBeNull();
      expect(await adapter.getSession(untouched.id)).toEqual(untouched);
    },
  },
  {
    name: 'deleteSessionsForOrg takes every member’s sessions, through the user’s org',
    async run({ adapter }) {
      const orgId = crypto.randomUUID();
      const [member, outsider] = [await seedUser(adapter, { orgId }), await seedUser(adapter)];
      const [inside, outside] = [session(member), session(outsider)];
      await adapter.createSession(inside);
      await adapter.createSession(outside);
      expect(await adapter.deleteSessionsForOrg(orgId)).toBe(1);
      expect([await adapter.getSession(inside.id), await adapter.getSession(outside.id)]).toEqual([
        null,
        outside,
      ]);
    },
  },
  {
    name: 'deleteSessionsCreatedBefore is strict: a session created at the instant survives',
    async run({ adapter }) {
      const owner = await seedUser(adapter);
      const [before, exactly] = [session(owner, at(-1)), session(owner, at(0))];
      await adapter.createSession(before);
      await adapter.createSession(exactly);
      expect(await adapter.deleteSessionsCreatedBefore(at(0))).toBeGreaterThanOrEqual(1);
      expect([await adapter.getSession(before.id), await adapter.getSession(exactly.id)]).toEqual([
        null,
        exactly,
      ]);
    },
  },
];
