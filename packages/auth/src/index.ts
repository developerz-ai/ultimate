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
  RegisterInput,
} from './auth';
export {
  AccountSchema,
  authenticate,
  defineAuth,
  login,
  logout,
  register,
  SessionSchema,
  UserSchema,
  VerificationSchema,
} from './auth';

export { BuiltinAdapter } from './builtin-adapter';
export type { AuthErrorCode, AuthThrowCode, OAuthExchangeFailure } from './errors';
export {
  AUTH_BORROWED_ERROR_CODES,
  AUTH_ERROR_CODES,
  AUTH_ERROR_TITLES,
  AuthError,
  accountLocked,
  apiKeyInvalid,
  authNotImplemented,
  authWriteFailed,
  emailVerifiedNotStored,
  forbidden,
  mfaRequired,
  oauthAccountNotLinked,
  oauthExchangeFailed,
  oauthStateInvalid,
  oauthTokenInvalid,
  passwordWeak,
  sessionExpired,
  sessionUnknown,
  unauthenticated,
} from './errors';

export { currentActor, requireActor, requireRole, requireScope } from './guards';
export type { IdTokenClaims, VerifyIdTokenInput } from './id-token';
export {
  decodeIdToken,
  ID_TOKEN_CLOCK_SKEW_MS,
  idTokenEmailVerified,
  verifyIdToken,
} from './id-token';

export { MemoryAdapter } from './memory-adapter';
export type {
  EnrolTotpInput,
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
export {
  assertOAuthCallback,
  beginOAuth,
  createPkce,
  OAUTH_PROVIDER_IDS,
  OAUTH_PROVIDERS,
  pkceChallenge,
} from './oauth';
export type {
  OAuthClientCredentials,
  OAuthExchangeOptions,
  OAuthFetch,
  OAuthTokens,
} from './oauth-exchange';
export { exchangeOAuthCode, oauthCredentials } from './oauth-exchange';
export type { CompleteOAuthLoginInput, OAuthSignInInput } from './oauth-login';
export { completeOAuthLogin, signInWithOAuth } from './oauth-login';
export type { OAuthProfile, OAuthProfileOptions } from './oauth-profile';
export { oauthProfile } from './oauth-profile';
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
export type { AuthLimiter, AuthRateLimitPolicy } from './rate-limit';
export {
  accountKey,
  createAuthLimiter,
  DEFAULT_AUTH_RATE_LIMIT,
  ipKey,
  loginFailed,
} from './rate-limit';
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
  listDevices,
  parseSessionToken,
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
  X_USERS_TABLE,
  X_VERIFICATIONS_TABLE,
} from './tables';

export { base64Url, matchesHash, randomToken, sha256Hex, timingSafeEqual } from './tokens';
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
