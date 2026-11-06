// Single responsibility: the records an authorization server keeps — clients, codes, grants, tokens
// and device codes — and the screened request a consent page shows. Data only; the store contract
// is `authorization-server-store.ts`, the rules that fill these are the grant modules.

/** The grants a server may enable. `authorization_code` and `refresh_token` are the default pair. */
export type AuthServerGrant =
  | 'authorization_code'
  | 'refresh_token'
  | 'client_credentials'
  | 'urn:ietf:params:oauth:grant-type:device_code';

export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** `none` is a public client (PKCE is its proof); the two secret methods are a confidential one. */
export type ClientAuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post';

export interface AuthServerClient {
  /** Opaque for a registered client; the https URL itself for a metadata-document client. */
  readonly clientId: string;
  readonly name: string;
  /** `sha256Hex` of the secret, `null` for a public client. The secret itself is never stored. */
  readonly secretHash: string | null;
  readonly authMethod: ClientAuthMethod;
  /** Compared byte for byte. Never a prefix, never a pattern, never normalised. */
  readonly redirectUris: readonly string[];
  readonly grantTypes: readonly AuthServerGrant[];
  /** What the client may ever be granted; a request narrows within it. Empty = the server's set. */
  readonly scopes: readonly string[];
  /** Resource indicators this client SERVES — what its introspection may see. */
  readonly resources: readonly string[];
  readonly createdAt: Date;
}

/** What `readRequest` screened and `approve` re-screens: the consent page's whole input. */
export interface AuthorizationRequest {
  readonly client: AuthServerClient;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  /** RFC 8707 resource indicator, `null` when the client named none. */
  readonly resource: string | null;
  readonly state: string | null;
  readonly codeChallenge: string;
}

export interface AuthCodeRecord {
  readonly codeHash: string;
  /** Pre-assigned: a replayed code revokes the grant this id names, whatever it minted. */
  readonly grantId: string;
  readonly clientId: string;
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly resource: string | null;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

export interface AuthGrantRecord {
  readonly id: string;
  readonly clientId: string;
  /** A person for the code and device grants, the client itself for `client_credentials`. */
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly resource: string | null;
  readonly createdAt: Date;
  /** The last refresh; the idle window runs from here. */
  readonly refreshedAt: Date;
  readonly revokedAt: Date | null;
}

export type AuthTokenKind = 'access' | 'refresh';

export interface AuthTokenRecord {
  readonly tokenHash: string;
  readonly kind: AuthTokenKind;
  readonly grantId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /** A rotated refresh token: kept so its replay is recognised, never honoured. */
  readonly retiredAt: Date | null;
}

export type DeviceStatus = 'pending' | 'approved' | 'denied' | 'consumed';

export interface DeviceCodeRecord {
  readonly deviceCodeHash: string;
  readonly userCodeHash: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly resource: string | null;
  readonly status: DeviceStatus;
  /** Set on approval: who consented and to what, narrowed. */
  readonly subject: string | null;
  readonly grantedScopes: readonly string[] | null;
  readonly intervalSeconds: number;
  readonly lastPolledAt: Date | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** What `resolve(token)` answers for a live access token. */
export interface ResolvedGrant {
  readonly subject: string;
  readonly scopes: ReadonlySet<string>;
  readonly clientId: string;
  readonly resource: string | null;
}
