// Single responsibility: with row security on, no statement reaches the database outside a
// transaction that carries the tenant. A statement sent bare — a raw `sql`, a report, a repository
// read — is wrapped in one: BEGIN, the tenant's `set_config`, the statement, COMMIT.

import type { DbClient } from './client';
import { isPlainRead } from './replica-route';
import type { SqlFragment } from './sql';
import { statementVerb } from './statement-shape';
import { currentTx, withTransaction } from './transaction';
import { transactionSettings } from './transaction-settings';

const SENDS: ReadonlySet<PropertyKey> = new Set(['query', 'one', 'execute']);

/**
 * A transaction's own control statements, sent by `withTransaction` on a client it could not pin
 * (a non-reservable one sends BEGIN through this very proxy): wrapping those would nest a second
 * transaction around the first one's BEGIN.
 */
const CONTROL: ReadonlySet<string> = new Set([
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'release',
]);

/**
 * `inner`, every other member untouched (`close`, `listen`, `profile`, `reserve`), with its three
 * sends wrapped. The accepted cost — a transaction per bare statement — is paid only when the
 * provider has a tenant to set; with none the statement goes as it came and the policy, reading an
 * unset tenant, answers no rows. A statement already inside a transaction is that transaction's.
 */
export function rowSecureClient<C extends DbClient>(inner: C): C {
  const wrapped = <T>(text: string, send: (client: DbClient) => Promise<T>): Promise<T> => {
    if (currentTx() !== undefined || transactionSettings() === undefined) return send(inner);
    if (CONTROL.has(statementVerb(text))) return send(inner);
    // `client: inner`, never this proxy: the BEGIN must pin a connection of the real pool. A plain
    // read is `READ ONLY`, so it does not mark a `withReplicaReads` scope as having written.
    return withTransaction((tx) => send(tx), { client: inner, readOnly: isPlainRead(text) });
  };
  const sends: DbClient = {
    query: <T>(fragment: SqlFragment) =>
      wrapped(fragment.text, (client) => client.query<T>(fragment)),
    one: <T>(fragment: SqlFragment) => wrapped(fragment.text, (client) => client.one<T>(fragment)),
    execute: (fragment: SqlFragment) =>
      wrapped(fragment.text, (client) => client.execute(fragment)),
  };
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (SENDS.has(property)) return Reflect.get(sends, property);
      return Reflect.get(target, property, receiver);
    },
  });
}
