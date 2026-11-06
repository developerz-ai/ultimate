// Single responsibility: `authorizationServer()` — one OAuth 2.1 authorization server for an app's
// MCP endpoint, public API, CLI or partner integrations alike. It returns plain `routes` for
// `runtime.routes` and the calls the app's own consent and device pages make; consent itself,
// who may be a client and what a subject becomes as an `Actor` stay the app's (axiom 8).

import {
  clientDirectory,
  type RegisterClientInput,
  type RegisteredClient,
  storeClient,
} from './authorization-server-clients';
import {
  type AuthorizationServerOptions,
  resolveAuthServerConfig,
} from './authorization-server-config';
import { consentInvalid } from './authorization-server-errors';
import {
  type ReadRequestResult,
  redirectWith,
  screenAuthorization,
} from './authorization-server-request';
import { authServerMetadata, authServerRoutes } from './authorization-server-routes';
import { resolveAccess, resolvedGrant } from './authorization-server-tokens';
import type { AuthorizationRequest, ResolvedGrant } from './authorization-server-types';
import type { AuthServerRoute } from './authorization-server-wire';
import { type DeviceReading, decideDevice, readDevice } from './grant-device';
import { randomToken, sha256Hex } from './tokens';

/** RFC 6749 §4.1.2 says "maximum of 10 minutes"; two is enough for a redirect and a POST. */
export const AUTH_CODE_TTL_MS = 2 * 60 * 1000;

export interface AuthorizationServer {
  readonly issuer: string;
  /** Spread into `runtime.routes`. Public; no cookie authenticates them. */
  readonly routes: readonly AuthServerRoute[];
  /** The RFC 8414 document the metadata route serves. */
  readonly metadata: Readonly<Record<string, unknown>>;
  /** The consent page's read of its own URL: what to show, or the refusal to show instead. */
  readRequest(url: string | URL): Promise<ReadRequestResult>;
  /** The consent action's approval: the redirect URL carrying `code`, `state` and `iss`. */
  approve(input: {
    readonly subject: string;
    readonly request: AuthorizationRequest;
    /** What the person granted — the request's scopes or fewer. Defaults to all of them. */
    readonly scopes?: readonly string[] | undefined;
  }): Promise<string>;
  /** The redirect URL carrying `error=access_denied`. */
  deny(input: { readonly request: AuthorizationRequest }): Promise<string>;
  /** `key` is the caller's bucket for user-code guesses: their address or session id. */
  readDevice(input: { readonly userCode: string; readonly key: string }): Promise<DeviceReading>;
  approveDevice(input: {
    readonly subject: string;
    readonly userCode: string;
    readonly key: string;
    readonly scopes: readonly string[];
  }): Promise<void>;
  denyDevice(input: { readonly userCode: string; readonly key: string }): Promise<void>;
  /** A client the app registers itself — a partner's machine client, a first-party CLI. */
  registerClient(input: RegisterClientInput): Promise<RegisteredClient>;
  /** A live access token's grant, or `null`: unknown, expired and revoked look alike. */
  resolve(token: string): Promise<ResolvedGrant | null>;
  /** Every grant of `subject` (of one client when named), dead on the next lookup. */
  revoke(input: {
    readonly subject: string;
    readonly clientId?: string | undefined;
  }): Promise<number>;
  /** Run from the app's own `task`: nothing here runs on a timer. */
  purge(input: { readonly before: Date }): Promise<number>;
}

/** The request as the query a client would have sent — what `approve` screens a second time. */
function requestParams(request: AuthorizationRequest): URLSearchParams {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: request.client.clientId,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    code_challenge_method: 'S256',
    scope: request.scopes.join(' '),
  });
  if (request.state !== null) params.set('state', request.state);
  if (request.resource !== null) params.set('resource', request.resource);
  return params;
}

export function authorizationServer(options: AuthorizationServerOptions): AuthorizationServer {
  const config = resolveAuthServerConfig(options);
  const directory = clientDirectory(config);
  const read = async (params: URLSearchParams): Promise<ReadRequestResult> => {
    const clientId = params.get('client_id');
    const client = clientId === null ? null : await directory.find(clientId);
    return screenAuthorization(config, client, params);
  };
  /** The request handed back is re-screened against the store: a forged object proves nothing. */
  const rescreen = async (request: AuthorizationRequest): Promise<AuthorizationRequest> => {
    const again = await read(requestParams(request));
    if (!again.ok) throw consentInvalid(again.description);
    return again.request;
  };
  const subjectOf = (subject: string): string => {
    if (subject.trim() === '') throw consentInvalid('the subject is empty');
    return subject;
  };
  return {
    issuer: config.issuer,
    routes: authServerRoutes(config, directory),
    metadata: authServerMetadata(config),
    readRequest: (url) => read(new URL(url).searchParams),
    async approve(input) {
      const subject = subjectOf(input.subject);
      const request = await rescreen(input.request);
      const scopes = [...new Set(input.scopes ?? request.scopes)];
      if (scopes.length === 0 || !scopes.every((scope) => request.scopes.includes(scope))) {
        throw consentInvalid('the approved scopes are empty or not a subset of the requested ones');
      }
      const now = config.clock.now();
      const code = randomToken(32);
      const grantId = `g_${randomToken(16)}`;
      // The grant exists before its code is redeemed, so a replayed code always has one to revoke.
      await config.store.putGrant({
        id: grantId,
        clientId: request.client.clientId,
        subject,
        scopes,
        resource: request.resource,
        createdAt: now,
        refreshedAt: now,
        revokedAt: null,
      });
      await config.store.putCode({
        codeHash: sha256Hex(code),
        grantId,
        clientId: request.client.clientId,
        subject,
        scopes,
        resource: request.resource,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        expiresAt: new Date(now.getTime() + AUTH_CODE_TTL_MS),
        usedAt: null,
      });
      return redirectWith(request.redirectUri, {
        code,
        iss: config.issuer,
        ...(request.state === null ? {} : { state: request.state }),
      });
    },
    async deny(input) {
      const request = await rescreen(input.request);
      return redirectWith(request.redirectUri, {
        error: 'access_denied',
        iss: config.issuer,
        ...(request.state === null ? {} : { state: request.state }),
      });
    },
    readDevice: (input) => readDevice(config, input.userCode, input.key),
    approveDevice: (input) =>
      decideDevice(config, {
        userCode: input.userCode,
        key: input.key,
        approve: { subject: subjectOf(input.subject), scopes: input.scopes },
      }),
    denyDevice: (input) =>
      decideDevice(config, { userCode: input.userCode, key: input.key, approve: null }),
    registerClient: (input) => storeClient(config, input),
    async resolve(token) {
      const live = await resolveAccess(config, token);
      return live === null ? null : resolvedGrant(live.grant);
    },
    revoke: (input) =>
      config.store.revokeGrants(
        { subject: input.subject, clientId: input.clientId },
        config.clock.now(),
      ),
    purge: ({ before }) =>
      config.store.purge(before, new Date(before.getTime() - config.refreshIdleMs)),
  };
}
