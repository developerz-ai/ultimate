/**
 * The invite link is a credential: whoever holds it proves they read the invited inbox. Declared
 * once through `defineMemberInvite`, so hashing at rest, single use, the constant-time compare and
 * the binding to ONE org are the framework's — a link minted for one org redeems in no other.
 */

import type { Auth, IssuedVerification, MailSender } from '@ultimat3/auth';
import {
  defineAuth,
  defineMemberInvite,
  memoryAuthAdapter,
  postgresAuthAdapter,
} from '@ultimat3/auth';
import { storeMode, systemClock } from '@ultimat3/core';
import { send } from '@ultimat3/mail';
import { appOrigin } from '../../shared/app-origin';
import type { MemberView } from './entity';
import { inviteEmail } from './mail';

/** A week: long enough to survive a holiday, short enough that a stale inbox is not a door. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const memberInvite = defineMemberInvite({
  template: inviteEmail.id,
  ttlMs: INVITE_TTL_MS,
});

/**
 * `x_verifications` and `x_users` through the framework's adapter, everywhere except `bun test` —
 * core's `storeMode`, as `app/runs/keys.ts` reads its keys. Built on first use: the adapter takes
 * the process client, which boot installs after this module loads.
 */
let auth: Auth | undefined;
export const inviteAuth = (): Auth => {
  auth ??= defineAuth({
    adapter: storeMode(Bun.env) === 'memory' ? memoryAuthAdapter() : postgresAuthAdapter(),
    clock: systemClock,
  });
  return auth;
};

/**
 * Where the mailed button lands: the feed, carrying the token and the org it redeems in — accept
 * needs both. Absolute, because a mail client follows nothing else (`safeMailHref` turns a path
 * into `#`).
 */
export const inviteLink = (token: string, orgId: string): string => {
  const url = new URL('/feed', appOrigin());
  url.search = new URLSearchParams({ invite: token, org: orgId }).toString();
  return url.href;
};

/**
 * Mints the member's single-use token — replacing any earlier one for that org and address — and mails
 * the invite carrying its link, in the member's locale. A re-run (the job retries) mints anew.
 */
export async function mailInvite(member: MemberView): Promise<IssuedVerification> {
  let link = '';
  const mail: MailSender = {
    async send(_template, to, _data, locale) {
      await send(inviteEmail, { ...member, link }, { to, locale });
    },
  };
  return memberInvite.invite(inviteAuth(), mail, {
    orgId: member.orgId,
    email: member.email,
    locale: member.locale,
    link: (token) => {
      link = inviteLink(token, member.orgId);
      return link;
    },
  });
}
