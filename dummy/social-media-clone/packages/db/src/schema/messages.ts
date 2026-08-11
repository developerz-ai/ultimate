// A chat message. Indexed `(conversationId, createdAt desc, id)` — the id is not decoration: a live
// query decides a row's position from the sort keys alone, so `createdAt` alone is a partial order
// and two messages sent in the same millisecond can swap between evaluations.

import { BODY_MAX } from '@social-media-clone/domain';
import { entity, invariant, text, timestamp, uuid } from '@ultimat3/entity';
import { conversations } from './conversations';
import { users } from './users';

export const messages = entity('messages', {
  columns: {
    id: uuid().primaryKey(),
    conversationId: uuid().references(() => conversations.id, { onDelete: 'cascade' }),
    authorId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    body: text({ max: BODY_MAX }),
    createdAt: timestamp().defaultNow(),
  },
  invariants: (c) => [invariant('message_body_present', c.body.trimmed().minLength(1))],
  indexes: [{ on: ['conversationId', 'createdAt', 'id'], order: 'desc' }],
});

export type Message = typeof messages.$row;
