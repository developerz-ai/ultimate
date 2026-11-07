// Single responsibility: passkey persistence — the record shapes, the seam slice, and the
// Postgres implementation of it over `x_passkeys` / `x_passkey_assertions`. The in-memory twin is
// in `memory-adapter.ts`; the DDL is in `tables.ts`.
//
// `credentialId` and `publicKeyCose` are base64url STRINGS, not bytes: the record has to survive a
// JSON round trip (`x dev`'s state dump, a queue payload, a test fixture) and a `Buffer` that came
// back as `{ type: 'Buffer', data: [...] }` would verify nothing.
//
// The public key is public by construction — WebAuthn verifies a signature WITH it, and it is the
// private half that never leaves the authenticator. The assertion row is the signed evidence of one
// ceremony, kept so a separate process can check what authorised a sensitive request without
// trusting the process that accepted it: nothing stored here is a credential.
//
// The SQL lives here rather than in `builtin-adapter.ts` because that file is at the 500-line
// ceiling (`x verify` filesize) and this is one responsibility with its own pair of tables. The row
// coercions below are deliberately local: importing them from `builtin-adapter.ts` would make the
// two modules import each other at runtime, and a cycle is a worse cost than five one-line readers.

import type { DbClient } from '@ultimat3/db';
import { sql } from '@ultimat3/db';

export interface PasskeyCredential {
  readonly id: string;
  readonly userId: string;
  /** base64url. The browser's handle for this authenticator; `findPasskeyByCredentialId`'s key. */
  readonly credentialId: string;
  /** CBOR/COSE, base64url. Public. */
  readonly publicKeyCose: string;
  /**
   * The authenticator's signature counter as of the last use. A stored value at or above an
   * assertion's own counter is a cloned authenticator, which is why the write is a compare-and-set
   * and not a plain update.
   */
  readonly signCount: number;
  /** Hints from `navigator.credentials` — `usb`, `nfc`, `internal`, `hybrid`. Never trusted. */
  readonly transports: readonly string[];
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

/**
 * One verified ceremony, as evidence. `requestDigest` is what makes step-up binding possible: an
 * assertion proves the holder of the authenticator signed `challenge`, and the digest records the
 * request body it was signed FOR, so a digest that does not match the request being served is a
 * refusal (`X_PASSKEY_STEP_UP_REQUIRED`) rather than a replay.
 */
export interface PasskeyAssertion {
  readonly id: string;
  readonly userId: string;
  readonly credentialId: string;
  /** base64url of the challenge the authenticator signed. Single use: a replay is refused. */
  readonly challenge: string;
  readonly requestDigest: string;
  readonly clientDataJson: string;
  readonly authenticatorData: string;
  readonly signature: string;
  readonly verifiedAt: Date;
  readonly expiresAt: Date;
}

export interface PasskeyStore {
  putPasskey(record: PasskeyCredential): Promise<PasskeyCredential>;
  /** Answers `null` for an unknown handle — never a throw: a passkey sign-in for an unregistered
   * authenticator is an anonymous attempt, and it must look identical to a wrong password. */
  findPasskeyByCredentialId(credentialId: string): Promise<PasskeyCredential | null>;
  listPasskeys(userId: string): Promise<readonly PasskeyCredential[]>;
  /**
   * Compare-and-set: writes only when the stored `signCount` is strictly BELOW `signCount`, so a
   * replayed or reordered assertion cannot wind the counter back. `false` means the row moved (or
   * is gone) and the caller must refuse — the memory and Postgres adapters answer identically, or
   * `adapter-parity-passkey.test.ts` fails.
   */
  updatePasskeyUsage(id: string, signCount: number, at: Date): Promise<boolean>;
  putPasskeyAssertion(record: PasskeyAssertion): Promise<PasskeyAssertion>;
  findPasskeyAssertion(id: string): Promise<PasskeyAssertion | null>;
}

// ── the Postgres half ────────────────────────────────────────────────────────────────────────────

type Row = Readonly<Record<string, unknown>>;

const textOrNull = (row: Row, key: string): string | null => {
  const value = row[key];
  return typeof value === 'string' ? value : null;
};

const text = (row: Row, key: string): string => textOrNull(row, key) ?? '';

const list = (row: Row, key: string): readonly string[] => {
  const value = row[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
};

const dateOrNull = (row: Row, key: string): Date | null => {
  const value = row[key];
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

const date = (row: Row, key: string): Date => dateOrNull(row, key) ?? new Date(0);

/**
 * `sign_count` is `bigint`, which the driver hands back as a STRING beyond 2^53 — and as a number
 * inside it, depending on the build — so both are read, and anything else is 0 rather than `NaN`.
 * A counter that read as `NaN` would compare false forever and disable the clone check silently.
 */
const counter = (row: Row, key: string): number => {
  const value = row[key];
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const toPasskey = (row: Row): PasskeyCredential => ({
  id: text(row, 'id'),
  userId: text(row, 'user_id'),
  credentialId: text(row, 'credential_id'),
  publicKeyCose: text(row, 'public_key_cose'),
  signCount: counter(row, 'sign_count'),
  transports: list(row, 'transports'),
  createdAt: date(row, 'created_at'),
  lastUsedAt: dateOrNull(row, 'last_used_at'),
});

const toPasskeyAssertion = (row: Row): PasskeyAssertion => ({
  id: text(row, 'id'),
  userId: text(row, 'user_id'),
  credentialId: text(row, 'credential_id'),
  challenge: text(row, 'challenge'),
  requestDigest: text(row, 'request_digest'),
  clientDataJson: text(row, 'client_data_json'),
  authenticatorData: text(row, 'authenticator_data'),
  signature: text(row, 'signature'),
  verifiedAt: date(row, 'verified_at'),
  expiresAt: date(row, 'expires_at'),
});

/**
 * The `PasskeyStore` slice over a live database. `PostgresAuthAdapter` composes one and delegates,
 * so the six members exist once and are tested once (`adapter-parity-passkey.test.ts` runs this and
 * the memory adapter through the same cases against the real DDL).
 */
export const passkeyStoreSql = (db: DbClient): PasskeyStore => ({
  /**
   * Upsert on the unique `credential_id`, so re-registering one authenticator rewrites its row
   * instead of making a second one the sign-in would never read. `id = excluded.id` is in the
   * update set deliberately: the caller then hands `record.id` to `updatePasskeyUsage`, so leaving
   * the old id in place would hand back a record whose id addresses no row. Nothing references
   * `x_passkeys.id` (no foreign key points at it), so rewriting it strands nothing. Every
   * credential column is overwritten, never merged: a re-registration states what this
   * authenticator is NOW, and a stale public key verifies nothing.
   */
  async putPasskey(record: PasskeyCredential): Promise<PasskeyCredential> {
    await db.execute(sql`
      insert into x_passkeys
        (id, user_id, credential_id, public_key_cose, sign_count, transports,
         created_at, last_used_at)
      values (${record.id}, ${record.userId}, ${record.credentialId}, ${record.publicKeyCose},
              ${record.signCount}, ${[...record.transports]}, ${record.createdAt},
              ${record.lastUsedAt})
      on conflict (credential_id) do update
        set id = excluded.id, user_id = excluded.user_id,
            public_key_cose = excluded.public_key_cose, sign_count = excluded.sign_count,
            transports = excluded.transports, created_at = excluded.created_at,
            last_used_at = excluded.last_used_at`);
    return record;
  },

  async findPasskeyByCredentialId(credentialId: string): Promise<PasskeyCredential | null> {
    const row = await db.one<Row>(
      sql`select * from x_passkeys where credential_id = ${credentialId}`,
    );
    return row === null ? null : toPasskey(row);
  },

  async listPasskeys(userId: string): Promise<readonly PasskeyCredential[]> {
    const rows = await db.query<Row>(sql`
      select * from x_passkeys where user_id = ${userId}
      order by created_at desc, id desc`);
    return rows.map(toPasskey);
  },

  /**
   * Compare-and-set in ONE statement — `sign_count < $n` is the whole clone check, and a
   * read-then-write would leave two concurrent assertions both reading the old counter and both
   * writing, which is the replay this exists to refuse. `changed > 0` is the verdict: `false`
   * covers an unknown id and an incoming counter that is not greater than the stored one, exactly
   * as the memory adapter's `stored >= signCount` does.
   */
  async updatePasskeyUsage(id: string, signCount: number, at: Date): Promise<boolean> {
    const changed = await db.execute(sql`
      update x_passkeys set sign_count = ${signCount}, last_used_at = ${at}
      where id = ${id} and sign_count < ${signCount}`);
    return changed > 0;
  },

  /**
   * `put` is replace, as `putVerification` is: one row per assertion id, rewritten whole. The
   * conflict target is `id` and NOT `request_digest` — two ceremonies over one request are two
   * pieces of evidence, and collapsing them would keep whichever wrote last.
   */
  async putPasskeyAssertion(record: PasskeyAssertion): Promise<PasskeyAssertion> {
    await db.execute(sql`
      insert into x_passkey_assertions
        (id, user_id, credential_id, challenge, request_digest, client_data_json,
         authenticator_data, signature, verified_at, expires_at)
      values (${record.id}, ${record.userId}, ${record.credentialId}, ${record.challenge},
              ${record.requestDigest}, ${record.clientDataJson}, ${record.authenticatorData},
              ${record.signature}, ${record.verifiedAt}, ${record.expiresAt})
      on conflict (id) do update
        set user_id = excluded.user_id, credential_id = excluded.credential_id,
            challenge = excluded.challenge, request_digest = excluded.request_digest,
            client_data_json = excluded.client_data_json,
            authenticator_data = excluded.authenticator_data, signature = excluded.signature,
            verified_at = excluded.verified_at, expires_at = excluded.expires_at`);
    return record;
  },

  async findPasskeyAssertion(id: string): Promise<PasskeyAssertion | null> {
    const row = await db.one<Row>(sql`select * from x_passkey_assertions where id = ${id}`);
    return row === null ? null : toPasskeyAssertion(row);
  },
});
