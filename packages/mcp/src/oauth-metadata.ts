// OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP endpoint — the framework half of
// the MCP authorization spec (2025-06-18, unchanged in 2025-11-25): a 401 names where the metadata
// lives (`WWW-Authenticate: Bearer resource_metadata="…"`), and the metadata names the
// authorization server(s) a client goes to for a token. The authorization server itself is the
// APP's — its consent page, its token endpoint, its revocation list — never this package's.

import { McpOAuthInvalidError } from './errors-transport';

/** The well-known suffix RFC 9728 §3 defines. */
export const PROTECTED_RESOURCE_WELL_KNOWN = '/.well-known/oauth-protected-resource';

export interface McpOAuth {
  /**
   * Issuer identifiers of the authorization servers that mint tokens this endpoint accepts
   * (`authorization_servers`). At least one; an absolute https URL, or http on localhost.
   */
  readonly authorizationServers: readonly string[];
  /**
   * The canonical URL of this MCP endpoint (RFC 8707 `resource`), e.g.
   * `https://www.example.com/mcp`. Omitted, it is the request's own public origin + the mount
   * path — right for one image deployed behind many hosts.
   */
  readonly resource?: string;
  /** `scopes_supported`. Omitted, the keys of `defineAppMcp({ scopes })`. */
  readonly scopesSupported?: readonly string[];
  /** `resource_name` — shown by a client's consent screen. */
  readonly resourceName?: string;
  /** `resource_documentation` — an absolute URL. */
  readonly resourceDocumentation?: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https anywhere, http only on loopback (RFC 9728 §3.3, OAuth 2.1 §1.5), and never a fragment. */
function isIssuerUrl(value: string): boolean {
  const url = URL.parse(value);
  if (url === null || url.hash !== '') return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
}

/** At `defineAppMcp`, never on a request. */
export function assertMcpOAuth(oauth: McpOAuth): void {
  if (oauth.authorizationServers.length === 0) {
    throw new McpOAuthInvalidError('authorizationServers is empty');
  }
  for (const issuer of oauth.authorizationServers) {
    if (!isIssuerUrl(issuer)) {
      throw new McpOAuthInvalidError(
        `${JSON.stringify(issuer)} is not an absolute https issuer URL`,
      );
    }
  }
  for (const key of ['resource', 'resourceDocumentation'] as const) {
    const value = oauth[key];
    if (value !== undefined && !isIssuerUrl(value)) {
      throw new McpOAuthInvalidError(
        `${key} ${JSON.stringify(value)} is not an absolute https URL`,
      );
    }
  }
}

/** The resource this request addresses: the declared one, else `<origin><path>`. */
export function resourceUrl(oauth: McpOAuth, origin: string, path: string): string {
  return oauth.resource ?? `${origin.replace(/\/+$/, '')}${path}`;
}

/**
 * RFC 9728 §3.1: the well-known suffix INSERTED between the host and the resource's path —
 * `https://x.test/mcp` → `https://x.test/.well-known/oauth-protected-resource/mcp`.
 */
export function metadataUrlFor(resource: string): string {
  const url = new URL(resource);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}${PROTECTED_RESOURCE_WELL_KNOWN}${path}`;
}

/** The two paths a host serves the document at: path-inserted (RFC 9728), and the root. */
export function metadataPaths(mountPath: string): readonly string[] {
  const inserted = `${PROTECTED_RESOURCE_WELL_KNOWN}${mountPath === '/' ? '' : mountPath}`;
  return inserted === PROTECTED_RESOURCE_WELL_KNOWN
    ? [PROTECTED_RESOURCE_WELL_KNOWN]
    : [inserted, PROTECTED_RESOURCE_WELL_KNOWN];
}

/** The metadata document for `resource`. Keys in RFC 9728 §2's names. */
export function protectedResourceMetadata(
  oauth: McpOAuth,
  resource: string,
  scopes: readonly string[],
): Record<string, unknown> {
  const supported = supportedScopes(oauth, scopes);
  return {
    resource,
    authorization_servers: [...oauth.authorizationServers],
    bearer_methods_supported: ['header'],
    ...(supported.length === 0 ? {} : { scopes_supported: [...supported].sort() }),
    ...(oauth.resourceName === undefined ? {} : { resource_name: oauth.resourceName }),
    ...(oauth.resourceDocumentation === undefined
      ? {}
      : { resource_documentation: oauth.resourceDocumentation }),
  };
}

/** `scopes_supported` and the challenge's `scope`: the stated list, else the app's scope names. */
export function supportedScopes(oauth: McpOAuth, scopes: readonly string[]): readonly string[] {
  return [...(oauth.scopesSupported ?? scopes)].sort();
}

/** RFC 6749 §3.3 `scope-token = 1*( %x21 / %x23-5B / %x5D-7E )`. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/**
 * At construction, beside `assertMcpOAuth`: every scope the challenge will name must be a
 * scope-token. A space would split one scope into two in `scope="a b"`, and a quote or backslash
 * would end the quoted-string early — a header a client parses into something nobody declared.
 */
export function assertScopeTokens(scopes: readonly string[]): void {
  for (const scope of scopes) {
    if (!SCOPE_TOKEN.test(scope)) {
      throw new McpOAuthInvalidError(
        `scope ${JSON.stringify(scope)} is not an RFC 6749 scope-token (printable ASCII, no space, quote or backslash)`,
      );
    }
  }
}

/**
 * The challenge a 401 carries. `error="invalid_token"` only when a token WAS sent (RFC 6750
 * §3.1: a request with no credential gets no error code). `scope` names what the resource
 * supports (RFC 6750 §3, MCP authorization 2025-06-18 / 2025-11-25 "scope selection"), so a
 * client can ask for it without first fetching the metadata; omitted when there is none.
 */
export function bearerChallenge(
  metadataUrl: string | undefined,
  tokenSent: boolean,
  scopes: readonly string[] = [],
): string {
  const params = ['realm="ultimate-mcp"'];
  if (tokenSent) params.push('error="invalid_token"');
  if (metadataUrl !== undefined) params.push(`resource_metadata="${metadataUrl}"`);
  if (scopes.length > 0) params.push(`scope="${scopes.join(' ')}"`);
  return `Bearer ${params.join(', ')}`;
}
