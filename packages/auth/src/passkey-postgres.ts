// Single responsibility: `PostgresAuthAdapter`'s `PasskeyStore` members, as SQL over the three
// `x_passkey*` tables (`tables.ts`). Split out of `builtin-adapter.ts`, which delegates one line per
// member; the readers are this file's because a passkey row is the only one with a bigint counter.

import { type DbClient, sql } from '@ultimat3/db';
import type {
  PasskeyCeremony,
  PasskeyChallengeRecord,
  PasskeyCredential,
  PasskeyEvidence,
  PasskeyStore,
} from './adapter';
import { usersUniqueViolation } from './builtin-adapter-violation';
import { authWriteFailed } from './errors';

type Row = Readonly<Record<string, unknown>>;

const str = (row: Row, key: string): string => {
  const value = row[key];
  return typeof value === 'string' ? value : '';
};
const strOrNull = (row: Row, key: string): string | null => {
  const value = row[key];
  return typeof value === 'string' ? value : null;
};
/** `bigint` arrives as a string from some drivers and a number from others; NaN is never a count. */
const int = (row: Row, key: string): number => {
  const value = Number(row[key]);
  return Number.isSafeInteger(value) ? value : 0;
};
const when = (row: Row, key: string): Date | null => {
  const value = row[key];
  if (value instanceof Date) return value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const strings = (row: Row, key: string): readonly string[] => {
  const value = row[key];
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
};

const toCredential = (row: Row): PasskeyCredential => ({
  id: str(row, 'id'),
  userId: str(row, 'user_id'),
  publicKey: str(row, 'public_key'),
  algorithm: int(row, 'algorithm'),
  signCount: int(row, 'sign_count'),
  transports: strings(row, 'transports'),
  createdAt: when(row, 'created_at') ?? new Date(0),
  lastUsedAt: when(row, 'last_used_at'),
});

const toChallenge = (row: Row, ceremony: PasskeyCeremony): PasskeyChallengeRecord => ({
  id: str(row, 'id'),
  // The DELETE matched on it, so the row's ceremony IS the one asked for.
  ceremony,
  userId: strOrNull(row, 'user_id'),
  digest: strOrNull(row, 'digest'),
  nonce: strOrNull(row, 'nonce'),
  // An unreadable instant is an expired one: fail closed.
  expiresAt: when(row, 'expires_at') ?? new Date(0),
  createdAt: when(row, 'created_at') ?? new Date(0),
});

const toEvidence = (row: Row): PasskeyEvidence => ({
  id: str(row, 'id'),
  userId: str(row, 'user_id'),
  credentialId: str(row, 'credential_id'),
  digest: str(row, 'digest'),
  nonce: str(row, 'nonce'),
  authenticatorData: str(row, 'authenticator_data'),
  clientDataJSON: str(row, 'client_data_json'),
  signature: str(row, 'signature'),
  publicKey: str(row, 'public_key'),
  algorithm: int(row, 'algorithm'),
  createdAt: when(row, 'created_at') ?? new Date(0),
});

/** The members, over a client resolved per call — the adapter's ambient `db()` rule. */
export function postgresPasskeyStore(client: () => DbClient): PasskeyStore {
  return {
    async putPasskey(credential) {
      let row: Row | null;
      try {
        row = await client().one<Row>(sql`
          insert into x_passkeys (id, user_id, public_key, algorithm, sign_count, transports,
                                  created_at)
          values (${credential.id}, ${credential.userId}, ${credential.publicKey},
                  ${credential.algorithm}, ${credential.signCount}, ${[...credential.transports]},
                  ${credential.createdAt})
          returning *`);
      } catch (error) {
        throw usersUniqueViolation('putPasskey', error) ?? error;
      }
      if (row === null) throw authWriteFailed('putPasskey', 'x_passkeys');
      return toCredential(row);
    },
    async findPasskey(id) {
      const row = await client().one<Row>(sql`select * from x_passkeys where id = ${id}`);
      return row === null ? null : toCredential(row);
    },
    async listPasskeys(userId) {
      const rows = await client().query<Row>(sql`
        select * from x_passkeys where user_id = ${userId} order by created_at asc, id collate "C" asc`);
      return rows.map(toCredential);
    },
    async advancePasskeyCounter(id, expected, next, at) {
      const row = await client().one<Row>(sql`
        update x_passkeys set sign_count = ${next}, last_used_at = ${at}
         where id = ${id} and sign_count = ${expected}
        returning id`);
      return row !== null;
    },
    async deletePasskey(userId, id) {
      const removed = await client().execute(
        sql`delete from x_passkeys where id = ${id} and user_id = ${userId}`,
      );
      return removed > 0;
    },
    async putPasskeyChallenge(record) {
      await client().execute(
        sql`delete from x_passkey_challenges where expires_at < ${record.createdAt}`,
      );
      await client().execute(sql`
        insert into x_passkey_challenges (id, ceremony, user_id, digest, nonce, expires_at,
                                          created_at)
        values (${record.id}, ${record.ceremony}, ${record.userId}, ${record.digest},
                ${record.nonce}, ${record.expiresAt}, ${record.createdAt})`);
    },
    async takePasskeyChallenge(id, ceremony) {
      // DELETE … RETURNING is the take: the row lock makes the second of two racing redemptions
      // find nothing, and a redeemed challenge leaves nothing behind to sweep.
      const row = await client().one<Row>(sql`
        delete from x_passkey_challenges where id = ${id} and ceremony = ${ceremony}
        returning *`);
      return row === null ? null : toChallenge(row, ceremony);
    },
    async putPasskeyEvidence(evidence) {
      await client().execute(sql`
        insert into x_passkey_evidence (id, user_id, credential_id, digest, nonce,
                                        authenticator_data, client_data_json, signature,
                                        public_key, algorithm, created_at)
        values (${evidence.id}, ${evidence.userId}, ${evidence.credentialId}, ${evidence.digest},
                ${evidence.nonce}, ${evidence.authenticatorData}, ${evidence.clientDataJSON},
                ${evidence.signature}, ${evidence.publicKey}, ${evidence.algorithm},
                ${evidence.createdAt})`);
    },
    async listPasskeyEvidence(digest) {
      const rows = await client().query<Row>(sql`
        select * from x_passkey_evidence where digest = ${digest} order by created_at asc, id collate "C" asc`);
      return rows.map(toEvidence);
    },
  };
}
