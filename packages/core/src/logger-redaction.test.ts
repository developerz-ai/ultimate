// Single responsibility: pins what the logger redacts by KEY — the exact list, the compound
// credential names the matcher catches, and the ordinary names it must leave readable.
import { describe, expect, test } from 'bun:test';
import { frozenClock } from './clock';
import { createLogger, isRedactedKey, REDACTED, redactKeys } from './logger';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'info',
    clock: frozenClock('2026-07-26T10:00:00.000Z'),
    writer: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

describe('logger · redaction by key', () => {
  test('redacts secret keys anywhere in the payload', () => {
    redactKeys(['DATABASE_URL']);
    const { logger, lines } = capture();
    logger.info('boot', {
      DATABASE_URL: 'postgres://user:pw@host/db',
      password: 'hunter2',
      nested: { token: 'abc', keep: 'yes' },
    });
    expect(lines[0]).toMatchObject({
      DATABASE_URL: REDACTED,
      password: REDACTED,
      nested: { token: REDACTED, keep: 'yes' },
    });
  });

  /**
   * `isRedactedKey` lowercases the lookup, so three of the eight shipped defaults were stored
   * camelCase and matched nothing — and those three are the exact field names on `OAuthTokens`
   * (`accessToken`, `refreshToken`, `apiKey`). One `logger.info('token exchange', { tokens })`
   * wrote a live access token into the log store for the full retention.
   */
  test('every default redaction key actually matches the field it names', () => {
    const { logger, lines } = capture();
    logger.info('token exchange', {
      apiKey: 'ak_live_1',
      accessToken: 'at_live_1',
      refreshToken: 'rt_live_1',
      api_key: 'ak_live_2',
      access_token: 'at_live_2',
      refresh_token: 'rt_live_2',
      client_secret: 'cs_live_1',
      id_token: 'idt_live_1',
      private_key: 'pk_live_1',
      session_token: 'st_live_1',
      'set-cookie': 'x_session=abc; HttpOnly',
      keep: 'yes',
    });
    const line = lines[0] ?? {};
    for (const [key, value] of Object.entries(line)) {
      if (key === 'ts' || key === 'level' || key === 'msg' || key === 'keep') continue;
      expect([key, value]).toEqual([key, REDACTED]);
    }
    expect(line['keep']).toBe('yes');
  });

  /**
   * Exact-key matching let every COMPOUND credential name through: an action with `audit: true`
   * persisted `currentPassword`, `mfaSecret` and `resetToken` in clear, because `@ultimat3/action`
   * asks this same predicate. The framework's own `passwordHash` / `tokenHash` / `keyHash` columns
   * were not listed either.
   */
  test.each([
    'currentPassword',
    'newPassword',
    'new_password',
    'passwordConfirmation',
    'mfaSecret',
    'totpCode',
    'totp',
    'recoveryCode',
    'recovery_codes',
    'resetToken',
    'csrfToken',
    'x-api-key',
    'webhookSecret',
    'passwordHash',
    'tokenHash',
    'keyHash',
    'key_hash',
    'recoveryCodeHashes',
    'secretAccessKey',
    'appSecrets',
    'stripeApiKey',
    'vapidPrivateKey',
    'sessionToken',
    'bearerToken',
    'emailOtp',
    // Review of #616: key MATERIAL under any qualifier, the id half of a key pair, a provider
    // token in env spelling or camel, a registry auth blob, and a URL that embeds a password.
    'AWS_ACCESS_KEY_ID',
    'accessKeyId',
    'AWS_SESSION_TOKEN',
    'NPM_TOKEN',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'githubToken',
    'npmToken',
    'x-auth-token',
    'DOCKER_AUTH_CONFIG',
    'encryptionKey',
    'signingKey',
    'masterKey',
    'hmacKey',
    'ULTIMATE_SECRETS_KEY',
    'ULTIMATE_SECRETS_RETIRED_KEYS',
    'connectionString',
    'dsn',
    'sentryDsn',
    'databaseUrl',
    'DATABASE_URL',
    'REDIS_URL',
    // Security review of #591: the names an idempotent answer or an audit row carries a bearer
    // credential under that the table did not know.
    'credentials',
    'credential',
    'awsCredentials',
    'jwt',
    'accessJwt',
    'JWT',
    'bearer',
    'authBearer',
    'sessionId',
    'session_id',
    'sessionKey',
    'cookies',
    'sessionCookie',
    'privateKey',
    'privateKeyPem',
    'private_key_pem',
    'privateKeyJwk',
    'cvv',
    'cvv2',
    'cardCvv',
    'cvc',
    'pin',
    'PIN',
    'cardPin',
    'pinCode',
    'pin_hash',
  ])('a compound credential name is redacted: %s', (key) => {
    expect(isRedactedKey(key)).toBe(true);
    const { logger, lines } = capture();
    logger.info('audit', { input: { [key]: 'plaintext', keep: 'yes' } });
    expect(lines[0]?.['input']).toEqual({ [key]: REDACTED, keep: 'yes' });
  });

  // The other direction, or the matcher is a blunt instrument. A redacted field is one an operator
  // cannot correlate on: `@ultimat3/mail` logs `idempotencyToken` so a retry can be matched to its
  // first send, a paging token is how a listing is resumed, and a count of tokens is a bill.
  // Nothing here may touch an error `code`, and a NAME of a secret is not the secret.
  test.each([
    'idempotencyToken',
    'idempotencyKey',
    'idempotency_key',
    'pageToken',
    'nextPageToken',
    'continuationToken',
    'nextContinuationToken',
    'cursor',
    'tokens',
    'maxTokens',
    'inputTokens',
    'cache_read_input_tokens',
    'tokenCount',
    'tokenUrl',
    'token_type',
    'token_endpoint',
    'clientSecretEnv',
    'secretsPath',
    'secretName',
    'totpStep',
    'apiKeyId',
    'keyId',
    'recoveryCodesRemaining',
    // Review of #616, the other direction: a key that is a LOOKUP, an id, a path or a plain URL.
    'SSH_AUTH_SOCK',
    'cacheKey',
    'partitionKey',
    'primaryKey',
    'foreignKey',
    'sortKey',
    'i18nKey',
    'masterKeyId',
    'signingKeyId',
    'keys',
    'url',
    'envelopeUrl',
    'tokenEndpoint',
    'IDEMPOTENCY_TOKEN',
    'code',
    'statusCode',
    'keep',
    'key',
    'hash',
    'option',
    'author',
    // Security review of #591, the other direction: a short word is matched whole, never inside
    // another, and the readable half of each new family stays readable.
    'spinner',
    'pinned',
    'isPinned',
    'shipping',
    'opinion',
    'pinterestUrl',
    'pins',
    'credentialId',
    'credentialsPath',
    'jwksUrl',
    'jwtIssuer',
    'bearerFormat',
    'sessionStart',
    'sessionCount',
    'cookieName',
    'cookiePath',
    'privateKeyId',
    'cvvLength',
  ])('an ordinary name stays readable: %s', (key) => {
    expect(isRedactedKey(key)).toBe(false);
  });
});
