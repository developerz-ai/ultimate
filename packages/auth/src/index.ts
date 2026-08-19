// Single responsibility: the public API of @ultimat3/auth. Explicit named exports only — this
// list is what the http pipeline, the MCP surface and generated apps are allowed to depend on.

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
  UserPatch,
  UserStore,
  VerificationStore,
} from './adapter';
export type { ApiKeySummary, IssueApiKeyInput, IssuedApiKey, ParsedApiKey } from './api-keys';
export {
  API_KEY_NAMESPACE,
  API_KEY_PREFIX_SEGMENTS,
  apiKeyActor,
  apiKeyPrefix,
  describeApiKey,
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

export { BuiltinAdapter } from './builtin-adapter';
export type { AuthUserSummary } from './directory';
export { describeUser, findUserByExternalId, listOrgUsers } from './directory';
// The one normalisation an address gets before it is an identity key. Public because an app
// writing its own `AuthAdapter`, or its own login route, has to key exactly the way this does.
export { normaliseEmail } from './email';
export type { AuthErrorCode, AuthThrowCode, OAuthExchangeFailure } from './errors';
export {
  AUTH_BORROWED_ERROR_CODES,
  AUTH_ERROR_CODES,
  AUTH_ERROR_TITLES,
  AuthError,
  accountLocked,
  apiKeyInvalid,
  authLimiterNotShared,
  authLimiterPolicyMismatch,
  authNotImplemented,
  authWriteFailed,
  emailVerifiedNotStored,
  forbidden,
  kdfOverloaded,
  mfaRequired,
  mfaRequiredUnenforceable,
  mfaSecretInvalid,
  oauthAccountNotLinked,
  oauthDenied,
  oauthExchangeFailed,
  oauthLinkingDisabled,
  oauthProviderDuplicate,
  oauthProviderUnknown,
  oauthStateInvalid,
  oauthTokenInvalid,
  passwordWeak,
  restartAt,
  sessionExpired,
  sessionUnknown,
  unauthenticated,
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
  createJwksClient,
  DEFAULT_JWKS_TTL_MS,
  decodeJwtHeader,
  providerJwks,
  verifyJwtSignature,
} from './jwks';
export type { KdfGate, KdfLimits } from './kdf-gate';
export {
  configureKdfGate,
  createKdfGate,
  DEFAULT_KDF_LIMITS,
  kdfGate,
  resetKdfGate,
} from './kdf-gate';
export { MemoryAdapter } from './memory-adapter';
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
  createTotpReplayGuard,
  DEFAULT_MAX_TOTP_SUBJECTS,
  enrolTotp,
  generateRecoveryCodes,
  generateTotpSecret,
  redeemRecoveryCode,
  TOTP_DIGITS,
  TOTP_DRIFT_STEPS,
  TOTP_STEP_SECONDS,
  totpCode,
  totpStep,
  verifyTotp,
} from './mfa';
export type {
  BeginOAuthInput,
  OAuthCallback,
  OAuthHandshake,
  OAuthProvider,
  OAuthProviderId,
  PkcePair,
} from './oauth';
export { assertOAuthCallback, beginOAuth, createPkce, pkceChallenge } from './oauth';
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
  OAUTH_HANDSHAKE_COOKIE_PREFIX,
  openHandshake,
  readHandshakeCookie,
  sealHandshake,
} from './oauth-cookie';
export type { DiscoverOAuthProviderInput } from './oauth-discovery';
export { discoverOAuthProvider, discoveryUrl } from './oauth-discovery';
export type {
  OAuthClientCredentials,
  OAuthExchangeOptions,
  OAuthFetch,
  OAuthTokens,
} from './oauth-exchange';
export { exchangeOAuthCode, oauthCredentials } from './oauth-exchange';
export type {
  CompleteOAuthLoginInput,
  OAuthGrants,
  OAuthSignInInput,
  ResolveOAuthGrants,
} from './oauth-login';
export { completeOAuthLogin, signInWithOAuth } from './oauth-login';
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
export { OAUTH_ROUTE_STATUS, oauthLogin } from './oauth-route';
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
  parseHashParams,
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
  resolveActor,
} from './policy-bridge';
export type { UpdatePrivilegesResult } from './privileges';
export { updatePrivileges } from './privileges';
export type {
  AuthLimiter,
  AuthLimiterScope,
  AuthRateLimitPolicy,
  MemoryAuthLimiter,
} from './rate-limit';
export {
  accountKey,
  assertAuthLimiterPolicy,
  createAuthLimiter,
  DEFAULT_AUTH_RATE_LIMIT,
  DEFAULT_MAX_AUTH_LIMIT_KEYS,
  ipKey,
  loginFailed,
  ORG_ATTEMPT_FACTOR,
  orgKey,
  orgRateLimit,
} from './rate-limit';
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
  IDLE_SLIDE_DIVISOR,
  idleSlideMs,
  listDevices,
  parseSessionToken,
  readCookie,
  readSessionCookie,
  revokeOtherSessions,
  revokeSession,
  rotateSession,
  sessionCookie,
  sessionExpiry,
  verifySession,
} from './session';

export {
  AUTH_TABLE_NAMES,
  AUTH_TABLES,
  X_ACCOUNTS_TABLE,
  X_API_KEYS_TABLE,
  X_SESSIONS_TABLE,
  X_USERS_MIGRATION_1_3,
  X_USERS_TABLE,
  X_VERIFICATIONS_TABLE,
} from './tables';
export {
  base64Url,
  base64UrlBytes,
  matchesHash,
  randomToken,
  sha256Hex,
  timingSafeEqual,
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
