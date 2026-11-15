// The member invite through `defineMemberInvite`: the mailed link carries a token that redeems
// once, for that address in that org alone, and never as another purpose's token.
import { consumeVerification, type MailSender } from '@ultimat3/auth';
import { expect, test } from '@ultimat3/testing';
import type { MemberView } from './entity';
import { INVITE_TTL_MS, inviteAuth, mailInvite, memberInvite } from './invite-token';

const member: MemberView = {
  id: '00000000-0000-4000-8000-00000000d0a1',
  orgId: '00000000-0000-4000-8000-00000000d001',
  email: 'Lin@Tinta.example',
  name: 'Lin',
  role: 'author',
  tz: 'Europe/Madrid',
  locale: 'es',
  theme: 'system',
  digestOptIn: true,
};

/** A consume mails nothing; this sender says so if it is ever asked to. */
const silent: MailSender = {
  send: () => expect.unreachable('consuming an invite sends no mail'),
};

const refusalCode = async (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => expect.unreachable('the token redeemed'),
    (error: unknown) => (error as { readonly code?: unknown }).code,
  );

/**
 * The invitee's own account, outside any org: an invite is redeemed signed in, as the address it
 * was mailed to. The store lives for the file, so an account a test already made is reused.
 */
const invitee = async (email: string): Promise<string> => {
  const { adapter } = inviteAuth();
  const known = await adapter.findUserByEmail(email);
  if (known !== null) {
    await adapter.updateUser(known.id, { orgId: null });
    return known.id;
  }
  const id = crypto.randomUUID();
  await adapter.createUser({
    id,
    email,
    passwordHash: null,
    orgId: null,
    roles: [],
    createdAt: new Date(),
  });
  return id;
};

test('the invite mails a link carrying a token that redeems exactly once', async ({
  mail,
  runJobs,
}) => {
  const issued = await mailInvite(member);
  await runJobs.drain();

  const [sent] = mail.outbox();
  expect(sent?.message.to).toEqual(['lin@tinta.example']);
  expect(sent?.message.locale).toBe('es');
  // The button is the absolute link, carrying the org it redeems in: a mail client renders a
  // bare path as a dead `#`.
  expect(sent?.message.html).toContain(
    `href="http://localhost:3000/feed?invite=${issued.token}&amp;org=${member.orgId}`,
  );

  const userId = await invitee('lin@tinta.example');
  const redeem = () =>
    memberInvite.accept(inviteAuth(), { orgId: member.orgId, userId, token: issued.token });
  expect((await redeem()).user.orgId).toBe(member.orgId);
  expect(await refusalCode(redeem)).toBe('X_UNAUTHENTICATED');
});

test('an invite token is not another purpose’s, another org’s, nor another address’s', async ({
  mail: _mail,
}) => {
  const issued = await mailInvite(member);
  const runtime = { store: inviteAuth().adapter, clock: inviteAuth().clock, mail: silent };
  const lin = await invitee('lin@tinta.example');
  const mara = await invitee('mara@tinta.example');

  expect(
    await refusalCode(() =>
      consumeVerification(runtime, {
        purpose: 'password-reset',
        identifier: member.email,
        token: issued.token,
      }),
    ),
  ).toBe('X_UNAUTHENTICATED');
  const otherOrg = '00000000-0000-4000-8000-00000000d002';
  expect(
    await refusalCode(() =>
      memberInvite.accept(inviteAuth(), { orgId: otherOrg, userId: lin, token: issued.token }),
    ),
  ).toBe('X_UNAUTHENTICATED');
  expect(
    await refusalCode(() =>
      memberInvite.accept(inviteAuth(), { orgId: member.orgId, userId: mara, token: issued.token }),
    ),
  ).toBe('X_UNAUTHENTICATED');
  // Every refusal left it live: a wrong guess never burns the invitee's link.
  expect(
    (
      await memberInvite.accept(inviteAuth(), {
        orgId: member.orgId,
        userId: lin,
        token: issued.token,
      })
    ).user.orgId,
  ).toBe(member.orgId);
});

test('the token lives a week', async ({ mail: _mail }) => {
  const before = Date.now();
  const issued = await mailInvite(member);
  expect(issued.expiresAt.getTime() - before).toBeGreaterThanOrEqual(INVITE_TTL_MS);
  expect(issued.expiresAt.getTime() - before).toBeLessThan(INVITE_TTL_MS + 60_000);
});
