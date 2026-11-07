// Single responsibility: RFC 7591 dynamic client registration, for the MCP clients that still use
// it — on only under `registration: 'dynamic'`, counted per address. Never a machine client: an
// open endpoint handing out `client_credentials` would let anyone mint itself a scope.

import { isRedirectUri, storeClient } from './authorization-server-clients';
import type { ResolvedAuthServerConfig } from './authorization-server-config';
import type { AuthServerGrant, ClientAuthMethod } from './authorization-server-types';
import { DEVICE_GRANT } from './authorization-server-types';
import type { AuthServerHttpContext, AuthServerHttpRequest } from './authorization-server-wire';
import { jsonAnswer, throttledAnswer } from './authorization-server-wire';
import { isRecord } from './json';

const SELF_SERVICE_GRANTS: ReadonlySet<string> = new Set<AuthServerGrant>([
  'authorization_code',
  'refresh_token',
  DEVICE_GRANT,
]);
const METHODS: ReadonlySet<string> = new Set<ClientAuthMethod>([
  'none',
  'client_secret_basic',
  'client_secret_post',
]);

const metadataError = (error: string, description: string): Response =>
  jsonAnswer(400, { error, error_description: description });

const stringList = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;

export async function registerHandler(
  config: ResolvedAuthServerConfig,
  request: AuthServerHttpRequest,
  ctx: AuthServerHttpContext,
): Promise<Response> {
  try {
    await config.limiter.reserve(`oauth-register:${ctx.ip ?? 'unknown'}`);
  } catch (error) {
    const answer = throttledAnswer(error, 'too many registrations');
    if (answer === null) throw error;
    return answer;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(await request.bodyBytes()));
  } catch {
    return metadataError('invalid_client_metadata', 'the body is not JSON');
  }
  if (!isRecord(body)) return metadataError('invalid_client_metadata', 'the body is not an object');
  const grants = stringList(body['grant_types'] ?? ['authorization_code', 'refresh_token']);
  if (
    grants === null ||
    !grants.every((g) => SELF_SERVICE_GRANTS.has(g) && config.grants.has(g as AuthServerGrant))
  ) {
    return metadataError(
      'invalid_client_metadata',
      'a grant_type is not one this server registers',
    );
  }
  const redirects = stringList(body['redirect_uris'] ?? []);
  const needsRedirect = grants.includes('authorization_code');
  if (
    redirects === null ||
    (needsRedirect && redirects.length === 0) ||
    !redirects.every(isRedirectUri)
  ) {
    return metadataError(
      'invalid_redirect_uri',
      'redirect_uris must be https, or http on loopback',
    );
  }
  const method = body['token_endpoint_auth_method'] ?? 'none';
  if (typeof method !== 'string' || !METHODS.has(method)) {
    return metadataError('invalid_client_metadata', 'token_endpoint_auth_method is not supported');
  }
  const scope = body['scope'];
  const scopes = typeof scope === 'string' ? scope.split(' ').filter((s) => s !== '') : [];
  if (!scopes.every((s) => config.scopes.has(s))) {
    return metadataError('invalid_client_metadata', 'a scope is not one this server grants');
  }
  const name = body['client_name'];
  const { client, clientSecret } = await storeClient(config, {
    name: typeof name === 'string' && name !== '' ? name.slice(0, 200) : 'unnamed client',
    authMethod: method as ClientAuthMethod,
    redirectUris: redirects,
    grantTypes: grants as readonly AuthServerGrant[],
    scopes,
  });
  return jsonAnswer(201, {
    client_id: client.clientId,
    ...(clientSecret === null ? {} : { client_secret: clientSecret, client_secret_expires_at: 0 }),
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    client_name: client.name,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    token_endpoint_auth_method: client.authMethod,
    ...(scopes.length === 0 ? {} : { scope: scopes.join(' ') }),
  });
}
