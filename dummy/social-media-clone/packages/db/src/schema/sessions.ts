// A signed-in session. The token is stored HASHED: a leaked database row must not be a usable
// cookie, which is the same reason a password is not stored in `users`.

import { entity, text, timestamp, uuid } from '@ultimat3/entity';
import { users } from './users';

export const sessions = entity('sessions', {
  columns: {
    id: uuid().primaryKey(),
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text({ max: 128 }).unique(),
    /** Absolute expiry. An idle timeout is a second clock; one is enough for a demo. */
    expiresAt: timestamp(),
    createdAt: timestamp().defaultNow(),
  },
  indexes: [{ on: ['userId'] }, { on: ['expiresAt'] }],
});

export type Session = typeof sessions.$row;
