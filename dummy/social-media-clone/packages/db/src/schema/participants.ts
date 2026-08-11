// Who is in a conversation. The composite key is also the authorization fact: membership IS
// permission to read the thread, so there is no separate grant to keep in step.

import { entity, timestamp, uuid } from '@ultimat3/entity';
import { conversations } from './conversations';
import { users } from './users';

export const participants = entity('participants', {
  columns: {
    conversationId: uuid().references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    /** Drives the unread badge. Null means "never opened it". */
    lastReadAt: timestamp().nullable(),
    joinedAt: timestamp().defaultNow(),
  },
  primaryKey: ['conversationId', 'userId'],
  indexes: [{ on: ['userId'] }],
});

export type Participant = typeof participants.$row;
