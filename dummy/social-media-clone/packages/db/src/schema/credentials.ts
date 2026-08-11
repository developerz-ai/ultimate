// A password hash, split from `users` so a profile read never loads one. Nothing outside the auth
// service may select from this table.

import { entity, text, timestamp, uuid } from '@ultimat3/entity';
import { users } from './users';

export const credentials = entity('credentials', {
  columns: {
    userId: uuid()
      .references(() => users.id, { onDelete: 'cascade' })
      .primaryKey(),
    /** Argon2id in production. The demo's seeded hashes are for `user`/`admin` and nothing else. */
    passwordHash: text({ max: 255 }),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
});

export type Credential = typeof credentials.$row;
