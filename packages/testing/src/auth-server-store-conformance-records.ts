// The records `authServerStoreConformance` writes, each under ids a check minted for itself — a
// shared table holds every check's and every run's rows, so no check may read a neighbour's.

import type {
  AuthCodeRecord,
  AuthGrantRecord,
  AuthTokenRecord,
  DeviceCodeRecord,
} from '@ultimat3/auth/adapter';

const T0 = Date.parse('2026-11-06T09:00:00.000Z');

/** `T0` plus `seconds`: every instant a check passes is one of these. */
export const at = (seconds: number): Date => new Date(T0 + seconds * 1000);

/** An id no other check, run or process shares. */
export const idOf = (label: string): string => `conformance-${label}-${crypto.randomUUID()}`;

export const codeRecord = (codeHash: string, grantId: string): AuthCodeRecord => ({
  codeHash,
  grantId,
  clientId: 'c1',
  subject: 'u1',
  scopes: ['read', 'write'],
  resource: 'https://as.test/mcp',
  redirectUri: 'https://app.test/cb',
  codeChallenge: 'x'.repeat(43),
  expiresAt: at(120),
  usedAt: null,
});

export const tokenRecord = (
  tokenHash: string,
  grantId: string,
  kind: AuthTokenRecord['kind'] = 'refresh',
): AuthTokenRecord => ({
  tokenHash,
  kind,
  grantId,
  createdAt: at(0),
  expiresAt: at(3600),
  retiredAt: null,
});

export const grantRecord = (id: string, subject: string, clientId = 'c1'): AuthGrantRecord => ({
  id,
  clientId,
  subject,
  scopes: ['read'],
  resource: null,
  createdAt: at(0),
  refreshedAt: at(0),
  revokedAt: null,
});

export const deviceRecord = (deviceCodeHash: string, userCodeHash: string): DeviceCodeRecord => ({
  deviceCodeHash,
  userCodeHash,
  clientId: 'c1',
  scopes: ['read'],
  resource: null,
  status: 'pending',
  subject: null,
  grantedScopes: null,
  intervalSeconds: 5,
  lastPolledAt: null,
  createdAt: at(0),
  expiresAt: at(600),
});
