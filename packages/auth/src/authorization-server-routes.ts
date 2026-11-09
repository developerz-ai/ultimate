// Single responsibility: the server's wire, as plain routes an app spreads into `runtime.routes` —
// the RFC 8414 metadata document, `POST /oauth/token` (every enabled grant), `/oauth/revoke`,
// `/oauth/introspect`, and, when enabled, `/oauth/register` and `/oauth/device`. Each answers
// RFC 6749 `{ error, error_description }`; the `X_` code a refusal is logged under stays off it.

import { logger } from '@ultimat3/core';
import { type ClientDirectory, clientAuthenticates } from './authorization-server-clients';
import type { ResolvedAuthServerConfig } from './authorization-server-config';
import { grantDisabled } from './authorization-server-errors';
import { registerHandler } from './authorization-server-register';
import { refused, type TokenOutcome } from './authorization-server-tokens';
import type { AuthServerClient, AuthServerGrant } from './authorization-server-types';
import { DEVICE_GRANT } from './authorization-server-types';
import {
  type AuthServerHttpContext,
  type AuthServerHttpRequest,
  type AuthServerRoute,
  jsonAnswer,
  outcomeAnswer,
  readClientCredentials,
  readForm,
  throttledAnswer,
} from './authorization-server-wire';
import { exchangeCode, exchangeRefresh } from './grant-authorization-code';
import { exchangeClientCredentials } from './grant-client-credentials';
import { pollDevice, startDevice } from './grant-device';
import { introspectToken, revokeToken } from './token-endpoints';

type ClientStep = (
  config: ResolvedAuthServerConfig,
  form: ReadonlyMap<string, string>,
  client: AuthServerClient,
) => Promise<TokenOutcome>;

const GRANT_STEPS = new Map<AuthServerGrant, ClientStep>([
  ['authorization_code', exchangeCode],
  ['refresh_token', exchangeRefresh],
  ['client_credentials', exchangeClientCredentials],
  [DEVICE_GRANT, pollDevice],
]);

export const AUTH_SERVER_METADATA_WELL_KNOWN = '/.well-known/oauth-authorization-server';

export function authServerMetadata(config: ResolvedAuthServerConfig): Record<string, unknown> {
  const at = (path: string): string => `${config.origin}${config.basePath}${path}`;
  const methods = ['none', 'client_secret_basic', 'client_secret_post'];
  return {
    issuer: config.issuer,
    authorization_endpoint: `${config.origin}${config.consentPath}`,
    token_endpoint: at('/oauth/token'),
    revocation_endpoint: at('/oauth/revoke'),
    introspection_endpoint: at('/oauth/introspect'),
    ...(config.dynamic ? { registration_endpoint: at('/oauth/register') } : {}),
    ...(config.grants.has(DEVICE_GRANT)
      ? { device_authorization_endpoint: at('/oauth/device') }
      : {}),
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: [...config.grants],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: methods,
    revocation_endpoint_auth_methods_supported: methods,
    introspection_endpoint_auth_methods_supported: methods.slice(1),
    scopes_supported: [...config.scopes].sort(),
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}

/** Form → authenticated client → the step. Every refusal is logged once, the `error` only. */
function clientRoute(
  config: ResolvedAuthServerConfig,
  directory: ClientDirectory,
  name: string,
  pick: (form: ReadonlyMap<string, string>) => ClientStep | TokenOutcome,
  success = 200,
): AuthServerRoute['handler'] {
  return async (request: AuthServerHttpRequest, ctx: AuthServerHttpContext) => {
    const form = await readForm(request);
    let outcome: TokenOutcome;
    try {
      outcome = await (async (): Promise<TokenOutcome> => {
        if (!(form instanceof Map)) return refused('invalid_request', form.refused);
        const credentials = readClientCredentials(request, form);
        if ('refused' in credentials) return refused('invalid_request', credentials.refused);
        // Before the client is authenticated, so the address is the only key there is.
        const client = await directory.find(credentials.clientId, ctx.ip ?? 'unknown');
        if (client === null || !clientAuthenticates(client, credentials)) {
          return refused('invalid_client', 'client authentication failed', 401);
        }
        const step = pick(form);
        return typeof step === 'function' ? step(config, form, client) : step;
      })();
    } catch (error) {
      const answer = throttledAnswer(error, 'too many client metadata fetches');
      if (answer === null) throw error;
      logger.info('auth.server.refused', { endpoint: name, error: 'temporarily_unavailable' });
      config.emit({ kind: 'refused', error: 'temporarily_unavailable', grantType: name });
      return answer;
    }
    if (outcome.ok) {
      config.emit({ kind: 'issued', grantType: name });
    } else {
      logger.info('auth.server.refused', { endpoint: name, error: outcome.error });
      config.emit({ kind: 'refused', error: outcome.error, grantType: name });
    }
    return outcomeAnswer(outcome, success);
  };
}

function tokenStep(config: ResolvedAuthServerConfig) {
  return (form: ReadonlyMap<string, string>): ClientStep | TokenOutcome => {
    const grantType = form.get('grant_type');
    if (grantType === undefined) return refused('invalid_request', 'grant_type is required');
    const step = GRANT_STEPS.get(grantType as AuthServerGrant);
    if (step === undefined || !config.grants.has(grantType as AuthServerGrant)) {
      const error = grantDisabled(grantType);
      logger.warn('auth.server.grant_disabled', { code: error.code, cause: error.cause });
      config.emit({ kind: 'grant-disabled', grantType });
      return refused('unsupported_grant_type', 'this server does not enable that grant');
    }
    return step;
  };
}

export function authServerRoutes(
  config: ResolvedAuthServerConfig,
  directory: ClientDirectory,
): readonly AuthServerRoute[] {
  const base = config.basePath;
  const post = (
    path: string,
    name: string,
    handler: AuthServerRoute['handler'],
  ): AuthServerRoute => ({
    method: 'POST',
    path: `${base}${path}`,
    handler,
    // Cookie-less and client-authenticated or PKCE-bound: CSRF has nothing to protect here.
    meta: { name: `oauth:${name}`, auth: 'public', csrf: 'cookieless', authenticate: () => null },
  });
  const document = authServerMetadata(config);
  const routes: AuthServerRoute[] = [
    {
      method: 'GET',
      path: `${AUTH_SERVER_METADATA_WELL_KNOWN}${base}`,
      handler: async () =>
        jsonAnswer(200, document, {
          'access-control-allow-origin': '*',
          'cache-control': 'max-age=300',
        }),
      meta: { name: 'oauth:metadata', auth: 'public' },
    },
    post('/oauth/token', 'token', clientRoute(config, directory, 'token', tokenStep(config))),
    post(
      '/oauth/revoke',
      'revoke',
      clientRoute(config, directory, 'revoke', () => revokeToken),
    ),
    post(
      '/oauth/introspect',
      'introspect',
      clientRoute(config, directory, 'introspect', () => introspectToken),
    ),
  ];
  if (config.dynamic) {
    routes.push(
      post('/oauth/register', 'register', (request, ctx) => registerHandler(config, request, ctx)),
    );
  }
  if (config.grants.has(DEVICE_GRANT)) {
    routes.push(
      post(
        '/oauth/device',
        'device',
        clientRoute(config, directory, 'device', () => startDevice),
      ),
    );
  }
  return routes;
}
