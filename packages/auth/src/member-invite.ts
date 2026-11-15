// Single responsibility: the member invite — a mailed, single-use credential bound to ONE tenant
// that moves the account it was mailed to into that tenant. The tenant is half the store key, so a
// token minted for X has no row under Y to match: cross-tenant redemption is a miss in the store,
// not a check a caller can forget. Who may invite, seat limits and the roles offered are the app's.

import { logger } from '@ultimat3/core';
import type { AuthUser } from './adapter';
import type { Auth } from './auth';
import { normaliseEmail } from './email';
import { AuthError, authForbidden, authWriteFailed } from './errors';
import { type UpdatePrivilegesResult, updatePrivileges } from './privileges';
import type { IssuedSession } from './session';
import { randomToken, sha256Hex } from './tokens';
import {
  defineVerificationPurpose,
  type IssuedVerification,
  type MailSender,
  type VerificationRuntime,
} from './verify';

export interface DefineMemberInviteInput {
  /** The verification purpose it registers. Unique, process-wide. Default `'member-invite'`. */
  readonly name?: string | undefined;
  /** The i18n catalog key of the invite mail. */
  readonly template: string;
  /** Required: how long an unredeemed invite stays a door is the app's call, stated once. */
  readonly ttlMs: number;
}

export interface InviteMemberInput {
  readonly orgId: string;
  readonly email: string;
  readonly locale: string;
  /** Builds the URL that carries the token. It must carry `orgId` too: accept needs both. */
  readonly link?: ((token: string) => string) | undefined;
  readonly data?: Readonly<Record<string, unknown>> | undefined;
}

export interface AcceptInviteInput {
  readonly orgId: string;
  readonly token: string;
  /** The signed-in account redeeming it. Only the account at the invited address can. */
  readonly userId: string;
  /** What the app's wrapper decided this invite grants. Replaces the account's roles; default none. */
  readonly roles?: readonly string[] | undefined;
  /** The caller's own session, rotated because membership is a privilege change. */
  readonly session?: IssuedSession['session'] | undefined;
}

export interface RevokeInviteInput {
  readonly orgId: string;
  readonly email: string;
  /** Logged as `auth.revocation` before the first write, like every revocation. */
  readonly reason: string;
}

export interface RevokedInvite {
  /** `true` when the address had already joined this tenant and has now been removed from it. */
  readonly memberRemoved: boolean;
  readonly sessionsRevoked: number;
}

export interface MemberInviteFlow {
  readonly purpose: string;
  /** Mint and mail the link. Re-inviting the address (a resend) supersedes the earlier link. */
  invite(auth: Auth, mail: MailSender, input: InviteMemberInput): Promise<IssuedVerification>;
  accept(auth: Auth, input: AcceptInviteInput): Promise<UpdatePrivilegesResult>;
  /** Withdraw the link and, when it was accepted, the membership and every session it held. */
  revoke(auth: Auth, input: RevokeInviteInput): Promise<RevokedInvite>;
}

/** JSON, not a separator: an org id is the app's string, and no character is safe to assume out. */
const storeKey = (orgId: string, email: string): string =>
  JSON.stringify([orgId, normaliseEmail(email)]);

const tenantOf = (orgId: string): string => {
  if (orgId.trim() !== '') return orgId;
  throw authForbidden('member invite', 'it names no tenant, so accepting it would join nothing');
};

/**
 * The sender accept's runtime carries: `consumeVerification` reads the store and the clock and
 * never the sender, so there is nothing for this one to do — and nothing for it to throw either.
 */
const consumeOnly: MailSender = { send: async () => {} };

/** Declare the flow once, at module scope. Registers its verification purpose. */
export function defineMemberInvite(input: DefineMemberInviteInput): MemberInviteFlow {
  // The key is already normalised by `storeKey`; the purpose's own normalisation must not refold it.
  const purpose = defineVerificationPurpose({
    name: input.name ?? 'member-invite',
    template: input.template,
    ttlMs: input.ttlMs,
    identifier: (raw) => raw,
  });
  const runtime = (auth: Auth, mail: MailSender): VerificationRuntime => ({
    store: auth.adapter,
    clock: auth.clock,
    mail,
  });

  return {
    purpose: purpose.name,

    async invite(auth, mail, invite) {
      const orgId = tenantOf(invite.orgId);
      const to = normaliseEmail(invite.email);
      // The store key is not an address; the mail goes to the address it was built from.
      const addressed: MailSender = {
        send: (template, _key, data, locale) => mail.send(template, to, data, locale),
      };
      return purpose.issue(runtime(auth, addressed), {
        identifier: storeKey(orgId, to),
        locale: invite.locale,
        link: invite.link,
        data: invite.data,
      });
    },

    async accept(auth, accept) {
      const user = await auth.adapter.findUserById(accept.userId);
      // The same refusal a bad token gets: which accounts exist is not this caller's to learn.
      if (user === null || user.disabledAt !== null) {
        throw new AuthError({
          code: 'X_UNAUTHENTICATED',
          cause: 'the member-invite token is unknown, already used, expired or does not match',
          fix: 'request a new link — member-invite tokens are single-use',
        });
      }
      // Checked BEFORE the consume, so the refusal leaves the link live for after the move.
      if (user.orgId !== null && user.orgId !== accept.orgId) {
        throw authForbidden(
          'member invite',
          'the account is a member of another tenant; membership is one tenant per account',
        );
      }
      // Keyed on THIS account's address: a link forwarded to another account finds no row.
      await purpose.consume(runtime(auth, consumeOnly), {
        identifier: storeKey(accept.orgId, user.email),
        token: accept.token,
      });
      return updatePrivileges(auth, user.id, joinPatch(user, accept, auth), accept.session);
    },

    async revoke(auth, revoke) {
      logger.warn('auth.revocation', {
        operation: 'revokeMemberInvite',
        scope: revoke.orgId,
        reason: revoke.reason,
      });
      const now = auth.clock.now();
      // No delete on the seam: the upsert replaces the live row with one whose token nobody holds.
      await auth.adapter.putVerification({
        id: randomToken(12),
        purpose: purpose.name,
        identifier: storeKey(revoke.orgId, revoke.email),
        tokenHash: sha256Hex(randomToken(32)),
        expiresAt: now,
        consumedAt: null,
        createdAt: now,
      });
      const user = await auth.adapter.findUserByEmail(normaliseEmail(revoke.email));
      if (user === null || user.orgId !== revoke.orgId) {
        return { memberRemoved: false, sessionsRevoked: 0 };
      }
      // A role is held in a tenant: one kept after removal is a grant waiting for the next join.
      const removed = await auth.adapter.updateUser(user.id, {
        orgId: null,
        roles: [],
        permissions: [],
      });
      if (removed === null) throw authWriteFailed('updateUser', 'x_users');
      const sessionsRevoked = await auth.adapter.deleteSessionsForUser(user.id);
      return { memberRemoved: true, sessionsRevoked };
    },
  };
}

/** Re-accepting into the tenant already held changes nothing but the spent link. */
const joinPatch = (user: AuthUser, accept: AcceptInviteInput, auth: Auth) =>
  user.orgId === accept.orgId
    ? {}
    : {
        orgId: accept.orgId,
        roles: [...(accept.roles ?? [])],
        permissions: [],
        // Redeeming a link mailed to the address is proof of the inbox.
        emailVerifiedAt: user.emailVerifiedAt ?? auth.clock.now(),
      };
