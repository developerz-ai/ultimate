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
  API_KEY_NAMESPACE,
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
  AccountSchema,
  authenticate,
  DEFAULT_MFA_ISSUER,
  defineAuth,
  login,
  logout,
  register,
  SessionSchema,
  UserSchema,
  VerificationSchema,
} from './auth';
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
  AUTH_ERROR_CODES,
  AUTH_ERROR_TITLES,
  AuthError,
  accountLocked,
  apiKeyInvalid,
  authForbidden,
  authLimiterNotShared,
  authLimiterPolicyMismatch,
  authUnauthenticated,
  authUniqueViolation,
  authWriteFailed,
  kdfOverloaded,
  mfaRequiredUnenforceable,
  mfaSecretInvalid,
  mfaSecretUnsealed,
  passwordWeak,
  sessionExpired,
  sessionUnknown,
} from './errors';
export { currentActor, requireActor } from './guards';
export type { IdTokenClaims, VerifyIdTokenInput } from './id-token';
export {
  decodeIdToken,
  ID_TOKEN_CLOCK_SKEW_MS,
  idTokenEmailVerified,
  verifyIdToken,
} from './id-token';
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
export type { KdfGate, KdfLimits } from './kdf-gate';
export {
  boundedKdfGate,
  configureKdfGate,
  kdfGate,
} from './kdf-gate';
export type { AuthLimiterFactory } from './limiter-install';
// `installedAuthLimiter` is deliberately absent: `defineAuth` is the one reader, and a second
// caller building limiters out of band would be a second answer to where failures are counted.
export { configureAuthLimiters, purgeAuthLimits, resetAuthLimiters } from './limiter-install';
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
} from './oauth';
export { assertOAuthCallback, beginOAuth, pkcePair } from './oauth';
export {
  APPLE_PROVIDER,
  BUILTIN_OAUTH_PROVIDER_IDS,
  BUILTIN_OAUTH_PROVIDERS,
  GITHUB_PROVIDER,
  GOOGLE_PROVIDER,
} from './oauth-builtins';
export type { HandshakeCookieOptions, HandshakeSealOptions } from './oauth-cookie';
export {
  clearHandshakeCookie,
  DEFAULT_HANDSHAKE_TTL_MS,
  handshakeCookie,
  handshakeCookieName,
  handshakeSecret,
  openHandshake,
  readHandshakeCookie,
  sealHandshake,
} from './oauth-cookie';
export type { DiscoverOAuthProviderInput } from './oauth-discovery';
export { discoverOAuthProvider, discoveryUrl } from './oauth-discovery';
// The OAuth refusals more than one OAuth module raises. A refusal with one thrower is exported
// from that module, below.
export type { OAuthExchangeFailure } from './oauth-errors';
export {
  oauthExchangeFailed,
  oauthProviderUnknown,
  oauthStateInvalid,
  oauthTokenInvalid,
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
export type {
  CompleteOAuthLoginInput,
  OAuthGrants,
  OAuthSignInInput,
  ResolveOAuthGrants,
} from './oauth-login';
export {
  completeOAuthLogin,
  emailVerifiedNotStored,
  oauthAccountNotLinked,
  oauthLinkingDisabled,
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
  oauthProviderDuplicate,
  oauthProviderIds,
  providerFor,
  registerOAuthProvider,
} from './oauth-registry';
export type { AuthRouteDescriptor, OAuthLoginOptions, OAuthLoginRoutes } from './oauth-route';
export { OAUTH_ROUTE_STATUS, oauthDenied, oauthLogin } from './oauth-route';
export type {
  PasswordParams,
  PasswordPolicy,
  PasswordVerification,
  StrengthOptions,
  VerifyPasswordInput,
} from './password';
export {
  checkPasswordStrength,
  DEFAULT_PASSWORD_PARAMS,
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
export {
  postgresAuthLimiter,
  SQL_AUTH_LIMIT_TABLES,
} from './rate-limit-postgres';
export type { DisabledUser } from './revocation';
export {
  disableUser,
  enableUser,
  revokeOrgSessions,
  revokeSessionsCreatedBefore,
  revokeUserSessions,
} from './revocation';
export type {
  CookieJar,
  CreateSessionInput,
  IssuedSession,
  RequestLike,
  SessionCookieOptions,
  SessionDevice,
  SessionExpiry,
  SessionPolicy,
  SessionRuntime,
} from './session';
export {
  clearSessionCookie,
  createSession,
  DEFAULT_SESSION_POLICY,
  idleSlideMs,
  listDevices,
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

export {
  AUTH_TABLE_NAMES,
  AUTH_TABLES,
} from './tables';
export {
  randomToken,
  sha256Hex,
} from './tokens';
export type {
  ConsumeVerificationInput,
  IssuedVerification,
  IssueVerificationInput,
  MailSender,
  VerificationPurpose,
  VerificationRuntime,
} from './verify';
export {
  consumeVerification,
  DEFAULT_VERIFICATION_TTL_MS,
  issueVerification,
  VERIFICATION_PURPOSES,
  VERIFICATION_TEMPLATES,
} from './verify';
export type {
  VerifyWorkloadTokenInput,
  WorkloadClaims,
  WorkloadToken,
} from './workload';
export { verifyWorkloadToken } from './workload';
