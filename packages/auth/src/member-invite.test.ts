// The invite link is a credential that moves a person into a tenant, so every way it can be wrong
// is a test here: expired, reused, aimed at another tenant, withdrawn, or redeemed by the wrong
// account. Each is refused with the code the verification door already throws — one
// indistinguishable X_UNAUTHENTICATED, because telling them apart tells an attacker which
// address has a live invite — and none of them changes the membership.

import { describe, expect, test } from 'bun:test';
import { type FrozenClock, frozenClock, installLogSink } from '@ultimat3/core';
import { type Auth, defineAuth } from './auth';
import { caught } from './auth-fixture';
import { defineMemberInvite, type MemberInviteFlow } from './member-invite';
import { type MemoryAuthAdapter, memoryAuthAdapter } from './memory-adapter';
import { createSession } from './session';
import { verificationPurposeNames } from './verification-purposes';
import type { MailSender } from './verify';

const START = 1_700_000_000_000;
const TTL = 60_000;

/**
 * Every flow needs its own purpose name: the registry is process-wide and refuses a repeat, and it
 * outlives this module — `--rerun-each` evaluates the file again over the same registry, so a
 * counter alone restarts at a name already taken. Skip any name the registry already holds.
 */
let flows = 0;
const freshName = (prefix: string): string => {
  const taken = new Set(verificationPurposeNames());
  let name = `${prefix}-${++flows}`;
  while (taken.has(name)) name = `${prefix}-${++flows}`;
  return name;
};
const flow = (): MemberInviteFlow =>
  defineMemberInvite({
    name: freshName('member-invite-test'),
    template: 'auth.member-invite',
    ttlMs: TTL,
  });

interface Sent {
  readonly to: string;
  readonly data: Readonly<Record<string, unknown>>;
}

const mailbox = (): { mail: MailSender; sent: Sent[] } => {
  const sent: Sent[] = [];
  return {
    sent,
    mail: {
      async send(_template, to, data) {
        sent.push({ to, data });
      },
    },
  };
};

interface World {
  readonly auth: Auth;
  readonly adapter: MemoryAuthAdapter;
  readonly clock: FrozenClock;
}

const world = async (users: readonly [string, string | null][] = []): Promise<World> => {
  const clock = frozenClock(START);
  const adapter = memoryAuthAdapter(clock);
  const auth = defineAuth({ adapter, clock });
  for (const [id, orgId] of users) {
    await adapter.createUser({
      id,
      email: `${id}@corp.test`,
      passwordHash: null,
      orgId,
      roles: orgId === null ? [] : ['member'],
      createdAt: new Date(START),
    });
  }
  return { auth, adapter, clock };
};

const inviteToken = async (
  w: World,
  f: MemberInviteFlow,
  orgId: string,
  email: string,
): Promise<string> => {
  const { mail } = mailbox();
  return (await f.invite(w.auth, mail, { orgId, email, locale: 'en' })).token;
};

describe('defineMemberInvite — accept', () => {
  test('a live invite makes the invited account a member of exactly that tenant', async () => {
    const w = await world([['ada', null]]);
    const f = flow();
    const { mail, sent } = mailbox();
    const issued = await f.invite(w.auth, mail, {
      orgId: 'org-x',
      email: '  Ada@Corp.TEST ',
      locale: 'en',
      link: (token) => `https://app.test/invites/accept?org=org-x&token=${token}`,
    });
    // Mailed to the address, not to the tenant-bound store key.
    expect(sent.map((m) => m.to)).toEqual(['ada@corp.test']);
    expect(sent[0]?.data['link']).toBe(
      `https://app.test/invites/accept?org=org-x&token=${issued.token}`,
    );
    const { user } = await f.accept(w.auth, {
      orgId: 'org-x',
      userId: 'ada',
      token: issued.token,
      roles: ['editor'],
    });
    expect(user.orgId).toBe('org-x');
    expect(user.roles).toEqual(['editor']);
    // Redeeming a link mailed to the address is proof of the inbox.
    expect(user.emailVerifiedAt?.getTime()).toBe(START);
  });

  test('joining rotates the session that redeemed it: membership is a privilege change', async () => {
    const w = await world([['ada', null]]);
    const f = flow();
    const token = await inviteToken(w, f, 'org-x', 'ada@corp.test');
    const own = await createSession(w.auth.sessions, { userId: 'ada' });
    const joined = await f.accept(w.auth, {
      orgId: 'org-x',
      userId: 'ada',
      token,
      session: own.session,
    });
    expect(joined.cookie).toBeString();
    expect(joined.session?.session.id).not.toBe(own.session.id);
    expect(await w.adapter.getSession(own.session.id)).toBeNull();
  });

  test('an expired invite is refused with X_UNAUTHENTICATED and grants nothing', async () => {
    const w = await world([['ada', null]]);
    const f = flow();
    const token = await inviteToken(w, f, 'org-x', 'ada@corp.test');
    w.clock.advance(TTL);
    const error = await caught(() => f.accept(w.auth, { orgId: 'org-x', userId: 'ada', token }));
    expect(error?.code).toBe('X_UNAUTHENTICATED');
    expect((await w.adapter.findUserById('ada'))?.orgId).toBeNull();
  });

  test('a used invite is refused on replay with X_UNAUTHENTICATED', async () => {
    const w = await world([['ada', null]]);
    const f = flow();
    const token = await inviteToken(w, f, 'org-x', 'ada@corp.test');
    await f.accept(w.auth, { orgId: 'org-x', userId: 'ada', token });
    // Removed, then the same link replayed: single use means it cannot put her back.
    await f.revoke(w.auth, { orgId: 'org-x', email: 'ada@corp.test', reason: 'offboarded' });
    const error = await caught(() => f.accept(w.auth, { orgId: 'org-x', userId: 'ada', token }));
    expect(error?.code).toBe('X_UNAUTHENTICATED');
    expect((await w.adapter.findUserById('ada'))?.orgId).toBeNull();
  });

  test('an invite for one tenant redeemed against another is refused with X_UNAUTHENTICATED', async () => {
    const w = await world([['ada', null]]);
    const f = flow();
    const token = await inviteToken(w, f, 'org-x', 'ada@corp.test');
    const error = await caught(() => f.accept(w.auth, { orgId: 'org-y', userId: 'ada', token }));
    expect(error?.code).toBe('X_UNAUTHENTICATED');
    expect((await w.adapter.findUserById('ada'))?.orgId).toBeNull();
    // The refusal consumed nothing: the right tenant still redeems it.
    expect((await f.accept(w.auth, { orgId: 'org-x', userId: 'ada', token })).user.orgId).toBe(
      'org-x',
    );
  });

  test('a revoked invite is refused with X_UNAUTHENTICATED', async () => {
    const w = await world([['ada', null]]);
    const f = flow();
    const token = await inviteToken(w, f, 'org-x', 'ada@corp.test');
    const revoked = await f.revoke(w.auth, {
      orgId: 'org-x',
      email: 'ada@corp.test',
      reason: 'sent in error',
    });
    expect(revoked.memberRemoved).toBe(false);
    const error = await caught(() => f.accept(w.auth, { orgId: 'org-x', userId: 'ada', token }));
    expect(error?.code).toBe('X_UNAUTHENTICATED');
    expect((await w.adapter.findUserById('ada'))?.orgId).toBeNull();
  });

  test('a resent invite supersedes the first link', async () => {
    const w = await world([['ada', null]]);
    const f = flow();
    const first = await inviteToken(w, f, 'org-x', 'ada@corp.test');
    const second = await inviteToken(w, f, 'org-x', 'ada@corp.test');
    const error = await caught(() =>
      f.accept(w.auth, { orgId: 'org-x', userId: 'ada', token: first }),
    );
    expect(error?.code).toBe('X_UNAUTHENTICATED');
    expect(
      (await f.accept(w.auth, { orgId: 'org-x', userId: 'ada', token: second })).user.orgId,
    ).toBe('org-x');
  });

  test('a link forwarded to another account is refused and stays live for the invitee', async () => {
    const w = await world([
      ['ada', null],
      ['mallory', null],
    ]);
    const f = flow();
    const token = await inviteToken(w, f, 'org-x', 'ada@corp.test');
    const error = await caught(() =>
      f.accept(w.auth, { orgId: 'org-x', userId: 'mallory', token }),
    );
    expect(error?.code).toBe('X_UNAUTHENTICATED');
    expect((await w.adapter.findUserById('mallory'))?.orgId).toBeNull();
    expect((await f.accept(w.auth, { orgId: 'org-x', userId: 'ada', token })).user.orgId).toBe(
      'org-x',
    );
  });

  test('a member of another tenant is refused with X_FORBIDDEN and the link survives', async () => {
    const w = await world([['ada', 'org-y']]);
    const f = flow();
    const token = await inviteToken(w, f, 'org-x', 'ada@corp.test');
    const error = await caught(() => f.accept(w.auth, { orgId: 'org-x', userId: 'ada', token }));
    expect(error?.code).toBe('X_FORBIDDEN');
    expect((await w.adapter.findUserById('ada'))?.orgId).toBe('org-y');
    await w.adapter.updateUser('ada', { orgId: null });
    expect((await f.accept(w.auth, { orgId: 'org-x', userId: 'ada', token })).user.orgId).toBe(
      'org-x',
    );
  });

  test('a disabled or unknown account is refused with X_UNAUTHENTICATED', async () => {
    const w = await world([['ada', null]]);
    const f = flow();
    const token = await inviteToken(w, f, 'org-x', 'ada@corp.test');
    await w.adapter.updateUser('ada', { disabledAt: new Date(START) });
    expect(
      (await caught(() => f.accept(w.auth, { orgId: 'org-x', userId: 'ada', token })))?.code,
    ).toBe('X_UNAUTHENTICATED');
    expect(
      (await caught(() => f.accept(w.auth, { orgId: 'org-x', userId: 'nobody', token })))?.code,
    ).toBe('X_UNAUTHENTICATED');
  });
});

describe('defineMemberInvite — revoke', () => {
  test('revoking an accepted invite removes the member and kills only their sessions', async () => {
    const lines: string[] = [];
    const restore = installLogSink((record) => lines.push(JSON.stringify(record)));
    try {
      const w = await world([
        ['ada', null],
        ['bob', 'org-x'],
      ]);
      const f = flow();
      const token = await inviteToken(w, f, 'org-x', 'ada@corp.test');
      await f.accept(w.auth, { orgId: 'org-x', userId: 'ada', token, roles: ['admin'] });
      await createSession(w.auth.sessions, { userId: 'ada' });
      await createSession(w.auth.sessions, { userId: 'ada' });
      await createSession(w.auth.sessions, { userId: 'bob' });
      const revoked = await f.revoke(w.auth, {
        orgId: 'org-x',
        email: 'ADA@corp.test',
        reason: 'left the team',
      });
      expect(revoked).toEqual({ memberRemoved: true, sessionsRevoked: 2 });
      const ada = await w.adapter.findUserById('ada');
      expect(ada?.orgId).toBeNull();
      // A role is held in a tenant: one kept after removal is a grant waiting for the next invite.
      expect(ada?.roles).toEqual([]);
      expect(await w.adapter.listSessions('ada')).toHaveLength(0);
      expect(await w.adapter.listSessions('bob')).toHaveLength(1);
      expect(lines.some((line) => line.includes('left the team'))).toBe(true);
    } finally {
      restore();
    }
  });

  test('revoking in one tenant never removes a member of another', async () => {
    const w = await world([['ada', 'org-y']]);
    const f = flow();
    await createSession(w.auth.sessions, { userId: 'ada' });
    const revoked = await f.revoke(w.auth, {
      orgId: 'org-x',
      email: 'ada@corp.test',
      reason: 'probe',
    });
    expect(revoked).toEqual({ memberRemoved: false, sessionsRevoked: 0 });
    expect((await w.adapter.findUserById('ada'))?.orgId).toBe('org-y');
    expect(await w.adapter.listSessions('ada')).toHaveLength(1);
  });
});

describe('defineMemberInvite — revoke removes only what an invite granted', () => {
  test('a member who never joined through an invite is not removed', async () => {
    const w = await world([['founder', 'org-x']]);
    const f = flow();
    await createSession(w.auth.sessions, { userId: 'founder' });
    // A pending invite to the founder's own address, then withdrawn: still not a way to remove them.
    await inviteToken(w, f, 'org-x', 'founder@corp.test');
    const revoked = await f.revoke(w.auth, {
      orgId: 'org-x',
      email: 'founder@corp.test',
      reason: 'probe',
    });
    expect(revoked).toEqual({ memberRemoved: false, sessionsRevoked: 0 });
    const founder = await w.adapter.findUserById('founder');
    expect(founder?.orgId).toBe('org-x');
    expect(founder?.roles).toEqual(['member']);
    expect(await w.adapter.listSessions('founder')).toHaveLength(1);
  });

  test('a member already in the org who redeems an invite there gains no removability', async () => {
    const w = await world([['founder', 'org-x']]);
    const f = flow();
    const token = await inviteToken(w, f, 'org-x', 'founder@corp.test');
    await f.accept(w.auth, { orgId: 'org-x', userId: 'founder', token });
    const revoked = await f.revoke(w.auth, {
      orgId: 'org-x',
      email: 'founder@corp.test',
      reason: 'probe',
    });
    expect(revoked.memberRemoved).toBe(false);
    expect((await w.adapter.findUserById('founder'))?.orgId).toBe('org-x');
  });
});

/**
 * The adapter, with `revoke` run INSIDE one accept: the first time `when` matches a store call,
 * the revoke runs before that call answers — the interleaving two requests produce in production.
 */
const interleaved = async (
  when: (method: 'take' | 'put', purpose: string) => boolean,
): Promise<{ auth: Auth; adapter: MemoryAuthAdapter; f: MemberInviteFlow }> => {
  const base = await world([['ada', null]]);
  const f = flow();
  let fired = false;
  let auth: Auth | undefined;
  const fire = async (method: 'take' | 'put', purpose: string): Promise<void> => {
    if (fired || auth === undefined || !when(method, purpose)) return;
    fired = true;
    await f.revoke(auth, { orgId: 'org-x', email: 'ada@corp.test', reason: 'raced' });
  };
  const adapter = new Proxy(base.adapter, {
    get(target, property) {
      if (property === 'takeVerification') {
        return async (purpose: string, identifier: string, hash: string) => {
          const taken = await target.takeVerification(purpose, identifier, hash);
          await fire('take', purpose);
          return taken;
        };
      }
      if (property === 'putVerification') {
        return async (record: Parameters<MemoryAuthAdapter['putVerification']>[0]) => {
          await target.putVerification(record);
          await fire('put', record.purpose);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  auth = defineAuth({ adapter, clock: base.clock });
  return { auth, adapter: base.adapter, f };
};

describe('defineMemberInvite — accept and revoke racing', () => {
  test('a revoke landing after the consume and before the join wins: nobody joins', async () => {
    let consumed = false;
    const { auth, adapter, f } = await interleaved((method, purpose) => {
      // The accept's own consume of the invite row is the first take on the bare purpose.
      if (method === 'take' && !purpose.includes(':') && !consumed) consumed = true;
      return consumed;
    });
    const token = (
      await f.invite(auth, mailbox().mail, { orgId: 'org-x', email: 'ada@corp.test', locale: 'en' })
    ).token;
    const error = await caught(() => f.accept(auth, { orgId: 'org-x', userId: 'ada', token }));
    expect(error?.code).toBe('X_UNAUTHENTICATED');
    const ada = await adapter.findUserById('ada');
    expect(ada?.orgId).toBeNull();
    expect(ada?.roles).toEqual([]);
  });

  test('a revoke landing after the join mark and before the check wins too', async () => {
    const { auth, adapter, f } = await interleaved(
      (method, purpose) => method === 'put' && purpose.endsWith(':joined'),
    );
    const token = (
      await f.invite(auth, mailbox().mail, { orgId: 'org-x', email: 'ada@corp.test', locale: 'en' })
    ).token;
    const error = await caught(() => f.accept(auth, { orgId: 'org-x', userId: 'ada', token }));
    expect(error?.code).toBe('X_UNAUTHENTICATED');
    expect((await adapter.findUserById('ada'))?.orgId).toBeNull();
  });
});

describe('defineMemberInvite — one refusal per purpose', () => {
  test('a disabled account is refused in the very words a bad token is, under any name', async () => {
    const w = await world([['ada', null]]);
    const f = defineMemberInvite({
      name: freshName('team-invite'),
      template: 'auth.team-invite',
      ttlMs: TTL,
    });
    const token = await inviteToken(w, f, 'org-x', 'ada@corp.test');
    const badToken = await caught(() =>
      f.accept(w.auth, { orgId: 'org-x', userId: 'ada', token: 'not-the-token' }),
    );
    await w.adapter.updateUser('ada', { disabledAt: new Date(START) });
    const disabled = await caught(() => f.accept(w.auth, { orgId: 'org-x', userId: 'ada', token }));
    const unknown = await caught(() =>
      f.accept(w.auth, { orgId: 'org-x', userId: 'nobody', token }),
    );
    expect(badToken?.cause).toContain(f.purpose);
    for (const refusal of [disabled, unknown]) {
      expect(refusal?.code).toBe(badToken?.code);
      expect(refusal?.cause).toBe(badToken?.cause);
      expect(refusal?.fix).toBe(badToken?.fix);
    }
  });
});

describe('defineMemberInvite — input', () => {
  test('an invite naming no tenant is refused before a link is minted', async () => {
    const w = await world();
    const f = flow();
    const { mail, sent } = mailbox();
    const error = await caught(() =>
      f.invite(w.auth, mail, { orgId: ' ', email: 'ada@corp.test', locale: 'en' }),
    );
    expect(error?.code).toBe('X_FORBIDDEN');
    expect(sent).toHaveLength(0);
  });

  test('a second flow under one purpose name is refused at declaration', () => {
    const name = freshName('member-invite-dup');
    defineMemberInvite({ name, template: 'auth.member-invite', ttlMs: TTL });
    expect(() => defineMemberInvite({ name, template: 'auth.member-invite', ttlMs: TTL })).toThrow(
      expect.objectContaining({ code: 'X_VERIFICATION_PURPOSE_INVALID' }),
    );
  });
});

/** mulberry32: a seeded generator, so a failing case is reproducible from the seed it prints. */
const prng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

describe('defineMemberInvite — tenant property', () => {
  test('an invite for tenant X never yields membership in any tenant Y', async () => {
    const f = flow();
    const ORGS = ['org-a', 'org-b', 'org-c', 'org-d'];
    const USERS = ['ada', 'bob', 'cy'];
    for (let seed = 1; seed <= 200; seed += 1) {
      const rand = prng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
      const w = await world(USERS.map((id) => [id, null] as [string, null]));
      // A history of invites, revokes and clock moves, then every token tried against every tenant.
      const issued: { orgId: string; token: string }[] = [];
      for (let step = 0; step < 6; step += 1) {
        const roll = rand();
        if (roll < 0.6) {
          const orgId = pick(ORGS);
          issued.push({ orgId, token: await inviteToken(w, f, orgId, `${pick(USERS)}@corp.test`) });
        } else if (roll < 0.8) {
          await f.revoke(w.auth, {
            orgId: pick(ORGS),
            email: `${pick(USERS)}@corp.test`,
            reason: 'p',
          });
        } else {
          w.clock.advance(Math.floor(rand() * TTL * 0.6));
        }
      }
      for (const { orgId: invitedTo, token } of issued) {
        for (const tryOrg of ORGS) {
          const userId = pick(USERS);
          const before = (await w.adapter.findUserById(userId))?.orgId ?? null;
          await caught(() => f.accept(w.auth, { orgId: tryOrg, userId, token }));
          const after = (await w.adapter.findUserById(userId))?.orgId ?? null;
          if (after !== before && after !== invitedTo) {
            expect.unreachable(
              `seed ${seed}: an invite for ${invitedTo} made ${userId} a member of ${after}`,
            );
          }
          if (after !== before) expect(after).toBe(tryOrg);
        }
      }
    }
  });
});
