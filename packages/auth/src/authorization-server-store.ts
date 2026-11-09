// Single responsibility: the contract an authorization server's storage answers, and the memory
// driver. Every single-use rule is a STORAGE guarantee — a code taken once, a refresh token rotated
// once, a device code consumed once — so each is one atomic method, never a read then a write.
// Postgres is `authorization-server-postgres.ts`; the contract test holds the two to one answer.

import { timingSafeEqual } from '@ultimat3/core';
import type {
  AuthCodeRecord,
  AuthGrantRecord,
  AuthServerClient,
  AuthTokenRecord,
  DeviceCodeRecord,
} from './authorization-server-types';

export type RefreshRotation =
  | { readonly outcome: 'rotated'; readonly grantId: string }
  /** The token was already retired: somebody holds a copy. The caller revokes `grantId`. */
  | { readonly outcome: 'replayed'; readonly grantId: string }
  | { readonly outcome: 'unknown' };

export type DeviceDecision =
  | { readonly status: 'approved'; readonly subject: string; readonly scopes: readonly string[] }
  | { readonly status: 'denied' };

export interface AuthServerStore {
  putClient(client: AuthServerClient): Promise<void>;
  getClient(clientId: string): Promise<AuthServerClient | null>;
  putCode(code: AuthCodeRecord): Promise<void>;
  /**
   * The code as stored, used or not, WITHOUT spending it: the grant checks client, PKCE and
   * redirect on this read so a request that could not redeem the code never burns it.
   */
  getCode(codeHash: string): Promise<AuthCodeRecord | null>;
  /** Marks the code used at `at` in the step that reads it. `fresh: false` is a replay. */
  takeCode(
    codeHash: string,
    at: Date,
  ): Promise<{ readonly code: AuthCodeRecord; readonly fresh: boolean } | null>;
  putGrant(grant: AuthGrantRecord): Promise<void>;
  getGrant(id: string): Promise<AuthGrantRecord | null>;
  /** Restarts the idle window. */
  touchGrant(id: string, at: Date): Promise<void>;
  revokeGrant(id: string, at: Date): Promise<void>;
  /** Every live grant of `subject` (of one client when named). Answers how many. */
  revokeGrants(
    filter: { subject: string; clientId?: string | undefined },
    at: Date,
  ): Promise<number>;
  putToken(token: AuthTokenRecord): Promise<void>;
  getToken(tokenHash: string): Promise<AuthTokenRecord | null>;
  /** Retire the live refresh token `tokenHash` and store `next`, atomically. */
  rotateRefresh(tokenHash: string, next: AuthTokenRecord, at: Date): Promise<RefreshRotation>;
  putDevice(device: DeviceCodeRecord): Promise<void>;
  deviceByUserCode(userCodeHash: string): Promise<DeviceCodeRecord | null>;
  /** Pending and unexpired at `at` → decided. `null` when it was not in that state. */
  decideDevice(
    userCodeHash: string,
    decision: DeviceDecision,
    at: Date,
  ): Promise<DeviceCodeRecord | null>;
  /**
   * The device code of `clientId`: stamps `lastPolledAt = at` and answers the row as it was BEFORE
   * the stamp. Another client's poll is `null` and stamps nothing, so it cannot `slow_down` the
   * device the code was issued to.
   */
  pollDevice(deviceCodeHash: string, clientId: string, at: Date): Promise<DeviceCodeRecord | null>;
  /** Approved → consumed. `false` when another poll took it first. */
  consumeDevice(deviceCodeHash: string, at: Date): Promise<boolean>;
  /**
   * Deletes codes, tokens and device codes expired before `before`, grants revoked before it, and
   * grants last refreshed before `idleBefore` (past the idle window, so unrefreshable).
   */
  purge(before: Date, idleBefore: Date): Promise<number>;
}

/**
 * Per PROCESS: right for a test and `x dev`, wrong for a fleet — a code minted on one replica is
 * redeemed on another. A deployment passes `postgresAuthServerStore({ executor })`.
 */
export function memoryAuthServerStore(): AuthServerStore {
  const clients = new Map<string, AuthServerClient>();
  const codes = new Map<string, AuthCodeRecord>();
  const grants = new Map<string, AuthGrantRecord>();
  const tokens = new Map<string, AuthTokenRecord>();
  const devices = new Map<string, DeviceCodeRecord>();
  const deviceOfUserCode = (hash: string): DeviceCodeRecord | undefined => {
    for (const device of devices.values()) {
      if (timingSafeEqual(device.userCodeHash, hash)) return device;
    }
    return undefined;
  };
  const expired = (row: { readonly expiresAt: Date }, before: Date): boolean =>
    row.expiresAt.getTime() < before.getTime();
  return {
    async putClient(client) {
      clients.set(client.clientId, client);
    },
    getClient: async (id) => clients.get(id) ?? null,
    async putCode(code) {
      codes.set(code.codeHash, code);
    },
    getCode: async (hash) => codes.get(hash) ?? null,
    async takeCode(hash, at) {
      const code = codes.get(hash);
      if (code === undefined) return null;
      if (code.usedAt !== null) return { code, fresh: false };
      codes.set(hash, { ...code, usedAt: at });
      return { code, fresh: true };
    },
    async putGrant(grant) {
      grants.set(grant.id, grant);
    },
    getGrant: async (id) => grants.get(id) ?? null,
    async touchGrant(id, at) {
      const grant = grants.get(id);
      if (grant !== undefined) grants.set(id, { ...grant, refreshedAt: at });
    },
    async revokeGrant(id, at) {
      const grant = grants.get(id);
      if (grant !== undefined && grant.revokedAt === null) {
        grants.set(id, { ...grant, revokedAt: at });
      }
    },
    async revokeGrants(filter, at) {
      let revoked = 0;
      for (const grant of grants.values()) {
        if (grant.revokedAt !== null || grant.subject !== filter.subject) continue;
        if (filter.clientId !== undefined && grant.clientId !== filter.clientId) continue;
        grants.set(grant.id, { ...grant, revokedAt: at });
        revoked += 1;
      }
      return revoked;
    },
    async putToken(token) {
      tokens.set(token.tokenHash, token);
    },
    getToken: async (hash) => tokens.get(hash) ?? null,
    async rotateRefresh(hash, next, at) {
      const token = tokens.get(hash);
      if (token === undefined || token.kind !== 'refresh') return { outcome: 'unknown' };
      if (token.retiredAt !== null) return { outcome: 'replayed', grantId: token.grantId };
      tokens.set(hash, { ...token, retiredAt: at });
      tokens.set(next.tokenHash, next);
      return { outcome: 'rotated', grantId: token.grantId };
    },
    async putDevice(device) {
      devices.set(device.deviceCodeHash, device);
    },
    deviceByUserCode: async (hash) => deviceOfUserCode(hash) ?? null,
    async decideDevice(hash, decision, at) {
      const device = deviceOfUserCode(hash);
      if (device === undefined || device.status !== 'pending') return null;
      if (device.expiresAt.getTime() <= at.getTime()) return null;
      const decided: DeviceCodeRecord =
        decision.status === 'approved'
          ? {
              ...device,
              status: 'approved',
              subject: decision.subject,
              grantedScopes: decision.scopes,
            }
          : { ...device, status: 'denied' };
      devices.set(device.deviceCodeHash, decided);
      return decided;
    },
    async pollDevice(hash, clientId, at) {
      const device = devices.get(hash);
      if (device === undefined || device.clientId !== clientId) return null;
      devices.set(hash, { ...device, lastPolledAt: at });
      return device;
    },
    async consumeDevice(hash, _at) {
      const device = devices.get(hash);
      if (device === undefined || device.status !== 'approved') return false;
      devices.set(hash, { ...device, status: 'consumed' });
      return true;
    },
    async purge(before, idleBefore) {
      let purged = 0;
      const sweep = <T>(rows: Map<string, T>, gone: (row: T) => boolean): void => {
        for (const [key, row] of [...rows]) {
          if (!gone(row)) continue;
          rows.delete(key);
          purged += 1;
        }
      };
      sweep(codes, (row) => expired(row, before));
      sweep(tokens, (row) => expired(row, before));
      sweep(devices, (row) => expired(row, before));
      sweep(
        grants,
        (row) =>
          (row.revokedAt !== null && row.revokedAt.getTime() < before.getTime()) ||
          row.refreshedAt.getTime() < idleBefore.getTime(),
      );
      return purged;
    },
  };
}
