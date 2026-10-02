/**
 * A site an org signs in to, and the credential it signs in with. One run per connection at a
 * time — that is `syncConnection`'s keyed concurrency (`apps/web/app/runs/jobs.ts`), not a column.
 *
 * `credential` and `exit` are `.sealed()`: the database holds `x1.<keyId>.<iv>.<ciphertext>` and never the
 * plaintext, a `where` on it does not compile, and the property is not enumerable on a row, so no
 * serialiser — a query's rows, a log line, an island prop — carries it by accident.
 */

import { entity, invariant, text, timestamp, uuid } from '@ultimat3/entity';
import { orgs } from './orgs';

export const CONNECTION_LABEL_MAX = 80;
export const CONNECTION_CREDENTIAL_MAX = 200;
export const CONNECTION_EXIT_MAX = 200;

export const connections = entity('connections', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id, { onDelete: 'cascade' })
      .tenant(),
    label: text({ max: CONNECTION_LABEL_MAX }),
    credential: text({ max: CONNECTION_CREDENTIAL_MAX }).sealed(),
    /**
     * The proxy this connection's runs leave through — a URL that carries its account, so sealed
     * like the credential. Nullable: none is the driver's own exit.
     */
    exit: text({ max: CONNECTION_EXIT_MAX }).sealed().nullable(),
    createdAt: timestamp().defaultNow(),
  },
  invariants: (c) => [invariant('connection_label_present', c.label.trimmed().minLength(1))],
  indexes: [{ on: ['orgId', 'createdAt'] }],
});

export type Connection = typeof connections.$row;
