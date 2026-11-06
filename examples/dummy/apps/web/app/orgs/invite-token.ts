/**
 * The invite link is a credential: whoever holds it proves they read the invited inbox. Declared
 * once as a verification purpose, so hashing at rest, single use and the constant-time compare are
 * the framework's (`defineVerificationPurpose`) — the same code path a password reset runs.
 */

import type { IssuedVerification, MailSender, VerificationRuntime } from '@ultimat3/auth';
import {
  defineVerificationPurpose,
  memoryAuthAdapter,
  postgresAuthAdapter,
  type VerificationStore,
} from '@ultimat3/auth';
import { storeMode, systemClock } from '@ultimat3/core';
import { send } from '@ultimat3/mail';
import { appOrigin } from '../../shared/app-origin';
import type { MemberView } from './entity';
import { inviteEmail } from './mail';

/** A week: long enough to survive a holiday, short enough that a stale inbox is not a door. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const memberInvite = defineVerificationPurpose({
  name: 'member-invite',
  template: inviteEmail.id,
  ttlMs: INVITE_TTL_MS,
});

/**
 * `x_verifications` through the framework's adapter, everywhere except `bun test` — core's
 * `storeMode`, as `app/runs/keys.ts` reads its keys. Built on first use: the adapter takes the
 * process client, which boot installs after this module loads.
 */
let store: VerificationStore | undefined;
const verifications = (): VerificationStore => {
  store ??= storeMode(Bun.env) === 'memory' ? memoryAuthAdapter() : postgresAuthAdapter();
  return store;
};

/** What `issue` and `consume` both run on: one store, the system clock, the invite mail. */
export const inviteRuntime = (mail: MailSender): VerificationRuntime => ({
  store: verifications(),
  clock: systemClock,
  mail,
});

/**
 * Where the mailed button lands: the feed, carrying the token and the address it was sent to.
 * Absolute, because a mail client follows nothing else (`safeMailHref` turns a path into `#`).
 */
export const inviteLink = (token: string, email: string): string => {
  const url = new URL('/feed', appOrigin());
  url.search = new URLSearchParams({ invite: token, email }).toString();
  return url.href;
};

/**
 * Mints the member's single-use token — replacing any earlier one for that address — and mails
 * the invite carrying its link, in the member's locale. A re-run (the job retries) mints anew.
 */
export async function mailInvite(member: MemberView): Promise<IssuedVerification> {
  let link = '';
  const mail: MailSender = {
    async send(_template, to, _data, locale) {
      await send(inviteEmail, { ...member, link }, { to, locale });
    },
  };
  return memberInvite.issue(inviteRuntime(mail), {
    identifier: member.email,
    locale: member.locale,
    link: (token) => {
      link = inviteLink(token, member.email);
      return link;
    },
  });
}
