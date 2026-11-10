// The `AuthAdapter` contract of `@ultimat3/auth` as shared examples, for an identity backend of
// your own (Better Auth, a directory): `behavesLike(authAdapterConformance, () => ({ adapter,
// clock }))`. One suite over every sub-store — users, the second factor, sessions, credentials,
// passkeys — so the question two adapters must never answer differently is asked of both alike.

import { test } from 'bun:test';
import { AUTH_ADAPTER_CREDENTIAL_CHECKS } from './auth-adapter-conformance-credentials';
import { AUTH_ADAPTER_MFA_CHECKS } from './auth-adapter-conformance-mfa';
import { AUTH_ADAPTER_PASSKEY_CHECKS } from './auth-adapter-conformance-passkeys';
import { AUTH_ADAPTER_SESSION_CHECKS } from './auth-adapter-conformance-sessions';
import type { AuthAdapterCheck, AuthAdapterSubject } from './auth-adapter-conformance-support';
import { AUTH_ADAPTER_USER_CHECKS } from './auth-adapter-conformance-users';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export type { AuthAdapterCheck, AuthAdapterSubject } from './auth-adapter-conformance-support';

export const AUTH_ADAPTER_CHECKS: readonly AuthAdapterCheck[] = [
  ...AUTH_ADAPTER_USER_CHECKS,
  ...AUTH_ADAPTER_MFA_CHECKS,
  ...AUTH_ADAPTER_SESSION_CHECKS,
  ...AUTH_ADAPTER_CREDENTIAL_CHECKS,
  ...AUTH_ADAPTER_PASSKEY_CHECKS,
];

export const authAdapterConformance: SharedExamples<
  AuthAdapterSubject | Promise<AuthAdapterSubject>
> = sharedExamples('an auth adapter', (subject) => {
  for (const check of AUTH_ADAPTER_CHECKS) {
    test(check.name, async () => {
      await check.run(await subject());
    });
  }
});
