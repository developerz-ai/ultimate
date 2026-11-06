// The shared authorization-server store: five tables over a structural `PgExecutor` (the pool is
// the host's). A fleet needs it — a code minted on one replica is redeemed on another — and every
// single-use rule is one conditional statement in `authorization-server-postgres-sql.ts`.

import type { PgExecutor } from '@ultimat3/core';
import * as SQL from './authorization-server-postgres-sql';
import type { AuthServerStore } from './authorization-server-store';
import type {
  AuthCodeRecord,
  AuthGrantRecord,
  AuthServerClient,
  AuthServerGrant,
  AuthTokenRecord,
  ClientAuthMethod,
  DeviceCodeRecord,
  DeviceStatus,
} from './authorization-server-types';

type Row = Readonly<Record<string, unknown>>;

const list = (value: unknown): readonly string[] =>
  typeof value === 'string' && value !== '' ? value.split(' ') : [];
const join = (values: readonly string[]): string => values.join(' ');
const text = (value: unknown): string => (typeof value === 'string' ? value : String(value));
const textOrNull = (value: unknown): string | null => (value === null ? null : text(value));
/** Every Postgres client answers `timestamptz` as a `Date` or an ISO string; both read the same. */
const date = (value: unknown): Date => (value instanceof Date ? value : new Date(text(value)));
const dateOrNull = (value: unknown): Date | null => (value === null ? null : date(value));

const toClient = (row: Row): AuthServerClient => ({
  clientId: text(row['client_id']),
  name: text(row['name']),
  secretHash: textOrNull(row['secret_hash']),
  authMethod: text(row['auth_method']) as ClientAuthMethod,
  redirectUris: list(row['redirect_uris']),
  grantTypes: list(row['grant_types']) as readonly AuthServerGrant[],
  scopes: list(row['scopes']),
  resources: list(row['resources']),
  createdAt: date(row['created_at']),
});

const toCode = (row: Row): AuthCodeRecord => ({
  codeHash: text(row['code_hash']),
  grantId: text(row['grant_id']),
  clientId: text(row['client_id']),
  subject: text(row['subject']),
  scopes: list(row['scopes']),
  resource: textOrNull(row['resource']),
  redirectUri: text(row['redirect_uri']),
  codeChallenge: text(row['code_challenge']),
  expiresAt: date(row['expires_at']),
  usedAt: dateOrNull(row['used_at']),
});

const toGrant = (row: Row): AuthGrantRecord => ({
  id: text(row['id']),
  clientId: text(row['client_id']),
  subject: text(row['subject']),
  scopes: list(row['scopes']),
  resource: textOrNull(row['resource']),
  createdAt: date(row['created_at']),
  refreshedAt: date(row['refreshed_at']),
  revokedAt: dateOrNull(row['revoked_at']),
});

const toToken = (row: Row): AuthTokenRecord => ({
  tokenHash: text(row['token_hash']),
  kind: text(row['kind']) === 'refresh' ? 'refresh' : 'access',
  grantId: text(row['grant_id']),
  createdAt: date(row['created_at']),
  expiresAt: date(row['expires_at']),
  retiredAt: dateOrNull(row['retired_at']),
});

const STATUSES: ReadonlySet<string> = new Set<DeviceStatus>([
  'pending',
  'approved',
  'denied',
  'consumed',
]);

const toDevice = (row: Row): DeviceCodeRecord => ({
  deviceCodeHash: text(row['device_code_hash']),
  userCodeHash: text(row['user_code_hash']),
  clientId: text(row['client_id']),
  scopes: list(row['scopes']),
  resource: textOrNull(row['resource']),
  // A status this file never writes is a hand-edited row: read as `denied`, which mints nothing.
  status: STATUSES.has(text(row['status'])) ? (text(row['status']) as DeviceStatus) : 'denied',
  subject: textOrNull(row['subject']),
  grantedScopes: row['granted_scopes'] === null ? null : list(row['granted_scopes']),
  intervalSeconds: Number(row['interval_seconds']),
  lastPolledAt: dateOrNull(row['last_polled_at']),
  createdAt: date(row['created_at']),
  expiresAt: date(row['expires_at']),
});

export interface PostgresAuthServerStoreOptions {
  /** Read on every call, so a declaration evaluated before the boot opened the pool still works. */
  readonly executor: PgExecutor;
}

export function postgresAuthServerStore(options: PostgresAuthServerStoreOptions): AuthServerStore {
  const exec = options.executor;
  const rows = (sql: string, params: readonly unknown[]) => exec.query<Row>(sql, params);
  const first = async <T>(sql: string, params: readonly unknown[], map: (row: Row) => T) => {
    const row = (await rows(sql, params))[0];
    return row === undefined ? null : map(row);
  };
  const count = async (sql: string, params: readonly unknown[]): Promise<number> =>
    Number((await rows(sql, params))[0]?.['n'] ?? 0);
  return {
    async putClient(c) {
      await rows(SQL.SQL_OAUTH_CLIENT_PUT, [
        c.clientId,
        c.name,
        c.secretHash,
        c.authMethod,
        join(c.redirectUris),
        join(c.grantTypes),
        join(c.scopes),
        join(c.resources),
        c.createdAt,
      ]);
    },
    getClient: (id) => first(SQL.SQL_OAUTH_CLIENT_GET, [id], toClient),
    async putCode(c) {
      await rows(SQL.SQL_OAUTH_CODE_PUT, [
        c.codeHash,
        c.grantId,
        c.clientId,
        c.subject,
        join(c.scopes),
        c.resource,
        c.redirectUri,
        c.codeChallenge,
        c.expiresAt,
      ]);
    },
    async takeCode(hash, at) {
      const taken = await first(SQL.SQL_OAUTH_CODE_TAKE, [hash, at], toCode);
      if (taken !== null) return { code: { ...taken, usedAt: null }, fresh: true };
      const spent = await first(SQL.SQL_OAUTH_CODE_GET, [hash], toCode);
      return spent === null ? null : { code: spent, fresh: false };
    },
    async putGrant(g) {
      await rows(SQL.SQL_OAUTH_GRANT_PUT, [
        g.id,
        g.clientId,
        g.subject,
        join(g.scopes),
        g.resource,
        g.createdAt,
        g.refreshedAt,
      ]);
    },
    getGrant: (id) => first(SQL.SQL_OAUTH_GRANT_GET, [id], toGrant),
    async touchGrant(id, at) {
      await rows(SQL.SQL_OAUTH_GRANT_TOUCH, [id, at]);
    },
    async revokeGrant(id, at) {
      await rows(SQL.SQL_OAUTH_GRANT_REVOKE, [id, at]);
    },
    revokeGrants: (filter, at) =>
      count(SQL.SQL_OAUTH_GRANTS_REVOKE, [filter.subject, filter.clientId ?? null, at]),
    async putToken(t) {
      await rows(SQL.SQL_OAUTH_TOKEN_PUT, [
        t.tokenHash,
        t.kind,
        t.grantId,
        t.createdAt,
        t.expiresAt,
      ]);
    },
    getToken: (hash) => first(SQL.SQL_OAUTH_TOKEN_GET, [hash], toToken),
    async rotateRefresh(hash, next, at) {
      const rotated = await rows(SQL.SQL_OAUTH_REFRESH_ROTATE, [
        hash,
        at,
        next.tokenHash,
        next.createdAt,
        next.expiresAt,
      ]);
      const grantId = rotated[0]?.['grant_id'];
      if (grantId !== undefined) return { outcome: 'rotated', grantId: text(grantId) };
      const held = await first(SQL.SQL_OAUTH_TOKEN_GET, [hash], toToken);
      if (held === null || held.kind !== 'refresh') return { outcome: 'unknown' };
      return { outcome: 'replayed', grantId: held.grantId };
    },
    async putDevice(d) {
      await rows(SQL.SQL_OAUTH_DEVICE_PUT, [
        d.deviceCodeHash,
        d.userCodeHash,
        d.clientId,
        join(d.scopes),
        d.resource,
        d.intervalSeconds,
        d.createdAt,
        d.expiresAt,
      ]);
    },
    deviceByUserCode: (hash) => first(SQL.SQL_OAUTH_DEVICE_BY_USER_CODE, [hash], toDevice),
    decideDevice: (hash, decision, at) =>
      first(
        SQL.SQL_OAUTH_DEVICE_DECIDE,
        decision.status === 'approved'
          ? [hash, 'approved', decision.subject, join(decision.scopes), at]
          : [hash, 'denied', null, null, at],
        toDevice,
      ),
    async pollDevice(hash, at) {
      // Two polls racing may both read the old stamp: harmless, `consumeDevice` is the single use.
      const device = await first(SQL.SQL_OAUTH_DEVICE_GET, [hash], toDevice);
      if (device !== null) await rows(SQL.SQL_OAUTH_DEVICE_POLLED, [hash, at]);
      return device;
    },
    async consumeDevice(hash) {
      return (await rows(SQL.SQL_OAUTH_DEVICE_CONSUME, [hash])).length === 1;
    },
    purge: (before, idleBefore) => count(SQL.SQL_OAUTH_PURGE, [before, idleBefore]),
  };
}
