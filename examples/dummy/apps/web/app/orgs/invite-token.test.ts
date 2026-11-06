// The member invite as a verification purpose: the mailed link carries a token that redeems once,
// for that address alone, and never as another purpose's token.
import { consumeVerification, type MailSender } from '@ultimat3/auth';
import { expect, test } from '@ultimat3/testing';
import type { MemberView } from './entity';
import { INVITE_TTL_MS, inviteRuntime, mailInvite, memberInvite } from './invite-token';

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

test('the invite mails a link carrying a token that redeems exactly once', async ({
  mail,
  runJobs,
}) => {
  const issued = await mailInvite(member);
  await runJobs.drain();

  const [sent] = mail.outbox();
  expect(sent?.message.to).toEqual(['lin@tinta.example']);
  expect(sent?.message.locale).toBe('es');
  // The button is the absolute link: a mail client renders a bare path as a dead `#`.
  expect(sent?.message.html).toContain(`href="http://localhost:3000/feed?invite=${issued.token}`);

  const runtime = inviteRuntime(silent);
  const redeem = () =>
    memberInvite.consume(runtime, { identifier: member.email, token: issued.token });
  expect((await redeem()).purpose).toBe('member-invite');
  expect(await refusalCode(redeem)).toBe('X_UNAUTHENTICATED');
});

test('an invite token is not another purpose’s token, nor another address’s', async ({
  mail: _mail,
}) => {
  const issued = await mailInvite(member);
  const runtime = inviteRuntime(silent);

  expect(
    await refusalCode(() =>
      consumeVerification(runtime, {
        purpose: 'password-reset',
        identifier: member.email,
        token: issued.token,
      }),
    ),
  ).toBe('X_UNAUTHENTICATED');
  expect(
    await refusalCode(() =>
      memberInvite.consume(runtime, { identifier: 'mara@tinta.example', token: issued.token }),
    ),
  ).toBe('X_UNAUTHENTICATED');
  // Both refusals left it live: a wrong guess never burns the invitee's link.
  expect(
    (await memberInvite.consume(runtime, { identifier: member.email, token: issued.token }))
      .identifier,
  ).toBe('lin@tinta.example');
});

test('the token lives a week', async ({ mail: _mail }) => {
  const before = Date.now();
  const issued = await mailInvite(member);
  expect(issued.expiresAt.getTime() - before).toBeGreaterThanOrEqual(INVITE_TTL_MS);
  expect(issued.expiresAt.getTime() - before).toBeLessThan(INVITE_TTL_MS + 60_000);
});
