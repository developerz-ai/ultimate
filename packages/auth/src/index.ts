// Single responsibility: the public API of @ultimat3/auth. Explicit named exports only — this
// list is what the http pipeline, the MCP surface and generated apps are allowed to depend on.

export type { PgExecutor } from '@ultimat3/core';
export type {
  AccountStore,
  ApiKeyStore,
  AuthAccount,
  AuthAdapter,
  AuthApiKeyRecord,
  AuthSession,
  AuthUser,
  AuthVerification,
  CreateUserInput,
  PasskeyCeremony,
  PasskeyChallengeRecord,
  PasskeyCredential,
  PasskeyEvidence,
  PasskeyStore,
  SessionPatch,
  SessionStore,
  StoredMfaSecret,
  UserPatch,
  UserStore,
  VerificationStore,
} from './adapter';
export type { ApiKeyCaller, ApiKeyResolverOptions } from './api-key-resolver';
export { apiKeyResolver } from './api-key-resolver';
export type {
  ApiKeyActorOptions,
  ApiKeySummary,
  ApiKeyVerifyStore,
  IssueApiKeyInput,
  IssuedApiKey,
  ParsedApiKey,
  VerifiedApiKey,
} from './api-keys';
export {
  API_KEY_TOUCH_MS,
  apiKeyActor,
  describeApiKey,
  directGrants,
  issueApiKey,
  parseApiKey,
  revokeApiKey,
  verifyApiKey,
} from './api-keys';
export type {
  Auth,
  AuthConfigInput,
  AuthMfaPolicy,
  LoginInput,
  LoginResult,
  OAuthLinkPolicy,
  RegisterInput,
} from './auth';
export {
  authenticate,
  defineAuth,
  login,
  logout,
  register,
} from './auth';
export type { AuthorizationServer, ReadRequestOptions } from './authorization-server';
export { authorizationServer } from './authorization-server';
export type {
  RegisterClientInput,
  RegisteredClient,
} from './authorization-server-clients';
export type {
  AuthorizationServerOptions,
  AuthServerEvent,
  AuthServerLifetimes,
} from './authorization-server-config';
export type { PostgresAuthServerStoreOptions } from './authorization-server-postgres';
export { postgresAuthServerStore } from './authorization-server-postgres';
export type { ReadRequestResult } from './authorization-server-request';
export type { AuthServerStore } from './authorization-server-store';
export { memoryAuthServerStore } from './authorization-server-store';
export type {
  AuthCodeRecord,
  AuthGrantRecord,
  AuthorizationRequest,
  AuthServerClient,
  AuthServerGrant,
  AuthTokenRecord,
  ClientAuthMethod,
  DeviceCodeRecord,
  ResolvedGrant,
} from './authorization-server-types';
export { DEVICE_GRANT } from './authorization-server-types';
export type {
  AuthServerHttpContext,
  AuthServerHttpRequest,
  AuthServerRoute,
} from './authorization-server-wire';
export { type PostgresAuthAdapter, postgresAuthAdapter } from './builtin-adapter';
/** The opaque per-principal id a per-request document hands the page's client store. */
export type { ClientScopeOptions } from './client-scope';
export { clientScopeOf } from './client-scope';
export type { AuthUserSummary } from './directory';
export { describeUser, findUserByExternalId, listOrgUsers } from './directory';
// The one normalisation an address gets before it is an identity key. Public because an app
// writing its own `AuthAdapter`, or its own login route, has to key exactly the way this does.
export { normaliseEmail } from './email';
export type { AuthErrorCode, AuthThrowCode } from './errors';
export {
  AUTH_BORROWED_ERROR_CODES,
  AuthError,
  accountLocked,
  apiKeyInvalid,
  authForbidden,
  authUnauthenticated,
  authUniqueViolation,
  authWriteFailed,
  kdfOverloaded,
  passwordWeak,
  sessionExpired,
  sessionUnknown,
  signInUnconfigured,
} from './errors';
export type { DeviceReading } from './grant-device';
export { currentActor, requireActor } from './guards';
export type { IdTokenClaims, VerifyIdTokenInput } from './id-token';
export {
  ID_TOKEN_CLOCK_SKEW_MS,
  verifyIdToken,
} from './id-token';
export type {
  IdentityBeginInput,
  IdentityCompleteInput,
  IdentityProvider,
  IdentityRedirect,
  IdentitySignInOptions,
  ResolveIdentityGrants,
  VerifiedIdentity,
} from './identity-provider';
export { signInWithIdentity } from './identity-provider';
export type { OidcIdentityProviderConfig } from './identity-provider-oidc';
export { oidcIdentityProvider } from './identity-provider-oidc';
export type {
  IdentityProviderRoutes,
  IdentityProviderRoutesOptions,
} from './identity-provider-routes';
export { identityProviderRoutes } from './identity-provider-routes';
export { OAUTH_ROUTE_STATUS } from './identity-provider-status';
export type {
  IdTokenKeys,
  JwksClientOptions,
  JwksKeySource,
  JwtAlgorithm,
  JwtHeader,
} from './jwks';
export {
  decodeJwtHeader,
  jwksClient,
  providerJwks,
  verifyJwtSignature,
} from './jwks';
export type {
  JwtBearerCaller,
  JwtBearerResolverOptions,
} from './jwt-bearer-resolver';
export { jwtBearerResolver } from './jwt-bearer-resolver';
export type { KdfGate, KdfLimits } from './kdf-gate';
// `installKdfGate` / `resetKdfGate` are `@ultimat3/auth/adapter`'s: a boot widens the gate.
export { boundedKdfGate, kdfGate } from './kdf-gate';
// `installedAuthLimiter` is deliberately absent: `defineAuth` is the one reader, and a second
// caller building limiters out of band would be a second answer to where failures are counted.
// The installers and their factory types are `@ultimat3/auth/adapter`'s, and only its: the boot
// calls them with what `apps/<app>/runtime.ts` named.
export { purgeAuthLimits } from './limiter-install';
export type { HandleDirectory } from './login-identity';
export { normaliseHandle } from './login-identity';
export { type MemoryAuthAdapter, memoryAuthAdapter } from './memory-adapter';
export type {
  EnrolTotpInput,
  MemoryTotpReplayGuard,
  RecoveryCodeSet,
  TotpEnrolment,
  TotpReplayGuard,
  TotpVerification,
  VerifyTotpInput,
} from './mfa';
export {
  base32Decode,
  base32Encode,
  DEFAULT_MAX_TOTP_SUBJECTS,
  enrolTotp,
  generateRecoveryCodes,
  generateTotpSecret,
  memoryTotpReplayGuard,
  recoveryCodeHash,
  TOTP_DIGITS,
  TOTP_DRIFT_STEPS,
  TOTP_STEP_SECONDS,
  totpCode,
  totpStep,
  verifyTotp,
} from './mfa';
export type { CompleteMfaOptions } from './mfa-challenge';
// `mfaRequired` itself is deliberately absent: the only X_MFA_REQUIRED worth throwing carries a
// challenge this package sealed, and `mfaChallengeRequired` is what seals one.
export {
  completeMfa,
  MFA_CHALLENGE_PURPOSE,
  MFA_CHALLENGE_TTL_MS,
  mfaChallengeRequired,
} from './mfa-challenge';
export type {
  PostgresTotpReplayGuard,
  PostgresTotpReplayGuardOptions,
} from './mfa-replay-postgres';
export { postgresTotpReplayGuard } from './mfa-replay-postgres';
export type { MfaSecretStore, SealMfaSecretsReport } from './mfa-secret';
export {
  countUnsealedMfaSecrets,
  MFA_SECRET_PURPOSE,
  openTotpSecret,
  saveTotpSecret,
  sealMfaSecrets,
} from './mfa-secret';
export type {
  BeginOAuthInput,
  OAuthCallback,
  OAuthHandshake,
  OAuthProvider,
  OAuthProviderId,
  PkcePair,
  TokenEndpointAuth,
} from './oauth';
export { assertOAuthCallback, beginOAuth, pkcePair } from './oauth';
export type {
  OAuthBearerCaller,
  OAuthBearerResolverOptions,
  OAuthTokenSource,
} from './oauth-bearer-resolver';
export { oauthBearerResolver } from './oauth-bearer-resolver';
export {
  BUILTIN_OAUTH_PROVIDER_IDS,
  BUILTIN_OAUTH_PROVIDERS,
  GITHUB_PROVIDER,
  GOOGLE_PROVIDER,
} from './oauth-builtins';
export type { HandshakeSealOptions } from './oauth-cookie';
export {
  DEFAULT_HANDSHAKE_TTL_MS,
  handshakeSecret,
  openHandshake,
  sealHandshake,
} from './oauth-cookie';
export type { DiscoverOAuthProviderInput } from './oauth-discovery';
export { discoverOAuthProvider, discoveryUrl } from './oauth-discovery';
// The OAuth refusals more than one OAuth module raises. A refusal with one thrower is exported
// from that module, below.
export type { OAuthExchangeFailure } from './oauth-errors';
export {
  oauthDenied,
  oauthExchangeFailed,
  oauthProviderUnknown,
  restartAt,
} from './oauth-errors';
export type {
  OAuthClientCredentials,
  OAuthExchangeOptions,
  OAuthFetch,
  OAuthTokens,
} from './oauth-exchange';
export { exchangeOAuthCode, oauthCredentials } from './oauth-exchange';
export type { OAuthGrantContext } from './oauth-grant-context';
export type { HandshakeCookieOptions } from './oauth-handshake-cookie';
export {
  clearHandshakeCookie,
  handshakeCookie,
  handshakeCookieName,
  readHandshakeCookie,
} from './oauth-handshake-cookie';
export type {
  CompleteOAuthLoginInput,
  OAuthGrants,
  OAuthSignInInput,
  ResolveOAuthGrants,
} from './oauth-login';
export {
  completeOAuthLogin,
  emailVerifiedNotStored,
  signInWithOAuth,
} from './oauth-login';
export {
  OAUTH_BASE_PATH,
  OAUTH_CALLBACK_ROUTE_PATH,
  OAUTH_START_ROUTE_PATH,
  oauthCallbackPath,
  oauthStartPath,
} from './oauth-paths';
export type { OAuthProfile, OAuthProfileOptions } from './oauth-profile';
export { oauthProfile } from './oauth-profile';
export {
  hasOAuthProvider,
  oauthProviderIds,
  providerFor,
  registerOAuthProvider,
} from './oauth-registry';
export type { AuthRouteDescriptor, OAuthLoginOptions, OAuthLoginRoutes } from './oauth-route';
export { oauthLogin } from './oauth-route';
// Passkeys (WebAuthn): sign-in and digest-bound step-up. The browser half is `@ultimat3/auth/client`.
export type {
  PasskeyPolicy,
  PasskeyPolicyInput,
  PasskeyRelyingParty,
} from './passkey-config';
export { verifyPasskeyEvidence } from './passkey-evidence';
export type { PasskeyLogin } from './passkey-login';
export { passkeyLogin } from './passkey-login';
export type { PasskeyStepUp, PasskeyStepUpOptions } from './passkey-step-up';
export { passkeyStepUp } from './passkey-step-up';
export type {
  PasskeyCreationOptions,
  PasskeyCredentialDescriptor,
  PasskeyRequestOptions,
} from './passkey-wire';
export type {
  PasswordParams,
  PasswordPolicy,
  PasswordVerification,
  StrengthOptions,
  VerifyPasswordInput,
} from './password';
export {
  checkPasswordStrength,
  DEFAULT_PASSWORD_POLICY,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password';
export type {
  AuthIdentity,
  PolicyActor,
  PolicyActorFields,
  ServiceIdentity,
} from './policy-bridge';
export {
  actorFromApiKey,
  actorFromService,
  actorFromUser,
  apiKeyScopes,
  isWildcardScope,
  resolveActor,
} from './policy-bridge';
export type { UpdatePrivilegesResult } from './privileges';
export { updatePrivileges } from './privileges';
export type {
  AuthLimiter,
  AuthLimiterScope,
  AuthRateLimitPolicy,
  AuthReservation,
  MemoryAuthLimiter,
} from './rate-limit';
export {
  accountKey,
  assertAuthLimiterPolicy,
  DEFAULT_AUTH_RATE_LIMIT,
  DEFAULT_MAX_AUTH_LIMIT_KEYS,
  ipKey,
  loginFailed,
  memoryAuthLimiter,
  orgKey,
  orgRateLimit,
} from './rate-limit';
export type { PostgresAuthLimiter, PostgresAuthLimiterOptions } from './rate-limit-postgres';
export { postgresAuthLimiter } from './rate-limit-postgres';
export type { DisabledUser } from './revocation';
export {
  disableUser,
  enableUser,
  revokeOrgSessions,
  revokeSessionsCreatedBefore,
  revokeUserSessions,
} from './revocation';
export type { SamlIdpMetadata } from './saml-metadata';
export { parseSamlMetadata } from './saml-metadata';
export type { SamlIdentityProviderConfig } from './saml-provider';
export { samlIdentityProvider } from './saml-provider';
export type {
  CookieJar,
  CreateSessionInput,
  IssuedSession,
  RequestLike,
  SessionCookieOptions,
  SessionExpiry,
  SessionPolicy,
  SessionRuntime,
} from './session';
export {
  clearSessionCookie,
  createSession,
  DEFAULT_SESSION_POLICY,
  idleSlideMs,
  readSessionCookie,
  remainingMaxAgeSeconds,
  revokeOtherSessions,
  revokeSession,
  rotateSession,
  sessionCookie,
  sessionExpiry,
  verifySession,
} from './session';
/** A sign-out response's headers: the session cookie expired, and `Clear-Site-Data`. */
export type { SignOutHeadersOptions } from './sign-out';
export { SIGN_OUT_CLEAR_SITE_DATA, signOutHeaders } from './sign-out';
export type {
  AuthSubjectRef,
  AuthSubjectTarget,
  AuthSubjectTargetOptions,
} from './subject-target';
export { authSubjectTarget } from './subject-target';

/** Also `@ultimat3/auth/schema`, the leaf a schema reader imports instead of this barrel. */
export {
  AUTH_SERVER_TABLES,
  AUTH_TABLE_NAMES,
  AUTH_TABLES,
  SQL_AUTH_LIMIT_TABLES,
  SQL_AUTH_SERVER_TABLES,
  SQL_TOTP_REPLAY_TABLE,
} from './tables';
export {
  randomToken,
  sha256Hex,
} from './tokens';
export type {
  ConsumeVerificationInput,
  DefineVerificationPurposeInput,
  IssuedVerification,
  IssueVerificationInput,
  MailSender,
  VerificationPurpose,
  VerificationPurposeHandle,
  VerificationRuntime,
} from './verify';
export {
  consumeVerification,
  DEFAULT_VERIFICATION_TTL_MS,
  defineVerificationPurpose,
  emailVerification,
  issueVerification,
  passwordReset,
  VERIFICATION_PURPOSES,
  VERIFICATION_TEMPLATES,
} from './verify';
export type {
  VerifyWorkloadTokenInput,
  WorkloadCheck,
  WorkloadClaims,
  WorkloadToken,
  WorkloadTokenCheck,
} from './workload';
export { checkWorkloadToken, verifyWorkloadToken } from './workload';
