// Single responsibility: one credential attempt's reservations across the three buckets — account,
// source address, tenant — taken BEFORE the expensive check and settled after it. `login` and
// `completeMfa` both run through this, so a password guess and a code guess are metered alike.

import type { Auth } from './auth';
import { type AuthLimiter, type AuthReservation, ipKey, orgKey } from './rate-limit';

export interface LoginAttempt {
  /**
   * The tenant bucket, joined once the address has resolved to an org — still before the KDF. A
   * refusal here gives back what this attempt already took: an attempt the tenant cap turned
   * away never tested a credential, so it must not also count against the account or address.
   */
  reserveOrg(orgId: string | null): Promise<void>;
  /**
   * No verdict was reached, or the factor checked was proven and another is still owed: every
   * reservation is given back and nothing is cleared.
   */
  release(): Promise<void>;
  /**
   * The credential is fully proven. Clears the ACCOUNT bucket — the typos before it were this
   * person's — and only refunds the shared ones: an address and a tenant count traffic from many
   * people, so one success is not evidence the failures beside it were benign.
   */
  succeed(): Promise<void>;
}

interface Taken {
  readonly limiter: AuthLimiter;
  readonly reservation: AuthReservation;
}

/**
 * Reserves account → ip, in that fixed order (and `reserveOrg` after both), so two concurrent
 * sign-ins never hold two of a shared limiter's rows in opposite orders. A failed attempt calls
 * nothing further: the reservations ARE the recorded failure.
 */
export async function openLoginAttempt(
  auth: Auth,
  account: string,
  ip: string | null,
): Promise<LoginAttempt> {
  const taken: Taken[] = [];
  const release = async (): Promise<void> => {
    for (const { limiter, reservation } of taken.splice(0)) await limiter.refund(reservation);
  };
  const take = async (limiter: AuthLimiter, key: string): Promise<void> => {
    try {
      taken.push({ limiter, reservation: await limiter.reserve(key) });
    } catch (refused) {
      await release();
      throw refused;
    }
  };

  await take(auth.limiter, account);
  if (ip !== null) await take(auth.limiter, ipKey(ip));

  return {
    reserveOrg: async (orgId) => {
      if (orgId !== null) await take(auth.orgLimiter, orgKey(orgId));
    },
    release,
    succeed: async () => {
      const [own, ...shared] = taken.splice(0);
      if (own !== undefined) await own.limiter.recordSuccess(own.reservation.key);
      for (const { limiter, reservation } of shared) await limiter.refund(reservation);
    },
  };
}
