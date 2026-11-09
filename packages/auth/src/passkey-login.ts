// Single responsibility: `passkeyLogin(auth)` — the two WebAuthn ceremonies a person signs in
// with: registering a passkey onto an account they already hold, and a usernameless sign-in that
// ends in the same session `login()` mints. Plain functions over `Auth`; the app wraps each in its
// own action (tier 2 cannot construct one), exactly as it wraps `login` and `completeMfa`.

import type { PasskeyCredential } from './adapter';
import type { Auth, LoginResult } from './auth';
import { base64Url } from './base64url';
import { PASSKEY_ALGORITHMS } from './cose-key';
import { acceptAssertion } from './passkey-assertion';
import { issuePasskeyChallenge, redeemPasskeyChallenge } from './passkey-challenge';
import { passkeyPolicyOf } from './passkey-config';
import { refusePasskey } from './passkey-errors';
import { readEnvelope, verifyAttestation } from './passkey-verify';
import type { PasskeyCreationOptions, PasskeyRequestOptions } from './passkey-wire';
import { resolveActor } from './policy-bridge';
import { createSession, sessionCookie } from './session';

export interface PasskeyLogin {
  /** For a signed-in user adding a passkey: hand the result to `newPasskey` in the browser. */
  registerOptions(input: { readonly userId: string }): Promise<PasskeyCreationOptions>;
  /** Verifies `newPasskey`'s answer and stores the credential under `userId`. */
  register(input: {
    readonly userId: string;
    readonly response: unknown;
  }): Promise<PasskeyCredential>;
  /** Usernameless: no account is named, so nothing here enumerates one. */
  loginOptions(): Promise<PasskeyRequestOptions>;
  /** Verifies `getPasskey`'s answer and mints a session — `login()`'s result shape. */
  login(input: {
    readonly response: unknown;
    readonly ip?: string | null | undefined;
    readonly userAgent?: string | null | undefined;
  }): Promise<LoginResult>;
}

export function passkeyLogin(auth: Auth): PasskeyLogin {
  const policy = passkeyPolicyOf(auth, 'passkeyLogin');
  return {
    async registerOptions({ userId }) {
      const user = await auth.adapter.findUserById(userId);
      if (user === null || user.disabledAt !== null) throw refusePasskey('register', 'user');
      const { challenge } = await issuePasskeyChallenge(auth, 'register', {
        userId,
        ttlMs: policy.challengeTtlMs,
      });
      const existing = await auth.adapter.listPasskeys(userId);
      return {
        challenge,
        rp: { id: policy.rpId, name: policy.rpName },
        // The user handle is the auth user's id — opaque, never the address (§14.6.1).
        user: {
          id: base64Url(new TextEncoder().encode(userId)),
          name: user.email,
          displayName: user.email,
        },
        pubKeyCredParams: PASSKEY_ALGORITHMS.map((alg) => ({ type: 'public-key' as const, alg })),
        timeout: policy.challengeTtlMs,
        attestation: 'none',
        authenticatorSelection: {
          residentKey: 'required',
          requireResidentKey: true,
          userVerification: 'required',
        },
        excludeCredentials: existing.map((row) => ({
          type: 'public-key' as const,
          id: row.id,
          transports: row.transports,
        })),
      };
    },

    async register({ userId, response }) {
      const envelope = readEnvelope(policy, response, 'webauthn.create');
      if (!envelope.ok) throw refusePasskey('register', envelope.check);
      const issued = await redeemPasskeyChallenge(auth, 'register', envelope.value.challenge);
      // A challenge issued to one account never registers a key onto another.
      if (issued.userId !== userId) throw refusePasskey('register', 'user');
      const attested = await verifyAttestation(policy, envelope.value);
      if (!attested.ok) throw refusePasskey('register', attested.check);
      return await auth.adapter.putPasskey({
        ...attested.value,
        id: attested.value.credentialId,
        userId,
        createdAt: auth.clock.now(),
        lastUsedAt: null,
      });
    },

    async loginOptions() {
      const { challenge } = await issuePasskeyChallenge(auth, 'login', {
        userId: null,
        ttlMs: policy.challengeTtlMs,
      });
      return {
        challenge,
        rpId: policy.rpId,
        timeout: policy.challengeTtlMs,
        userVerification: 'required',
        allowCredentials: [],
      };
    },

    async login({ response, ip, userAgent }) {
      const envelope = readEnvelope(policy, response, 'webauthn.get');
      if (!envelope.ok) throw refusePasskey('login', envelope.check);
      await redeemPasskeyChallenge(auth, 'login', envelope.value.challenge);
      const { credential } = await acceptAssertion(auth, policy, 'login', envelope.value, null);
      const user = await auth.adapter.findUserById(credential.userId);
      if (user === null || user.disabledAt !== null) throw refusePasskey('login', 'user');
      // A user-verified passkey is two factors in one gesture (possession + the device's PIN or
      // biometric), so the session is MFA-satisfied even where a TOTP secret is enrolled.
      const issued = await createSession(auth.sessions, {
        userId: user.id,
        ip: ip ?? null,
        userAgent,
        mfaSatisfied: true,
      });
      return {
        actor: resolveActor({ kind: 'user', user, session: issued.session }),
        session: issued.session,
        token: issued.token,
        cookie: sessionCookie(issued.token, auth.sessions.policy),
      };
    },
  };
}
