// A chat thread. `kind` distinguishes a 1:1 from a group because the two render differently and
// name themselves differently — a direct thread has no title, it has the other person.

import { entity, enumerated, text, timestamp, uuid } from '@ultimat3/entity';

export const CONVERSATION_KINDS = ['direct', 'group'] as const;

export const conversations = entity('conversations', {
  columns: {
    id: uuid().primaryKey(),
    kind: enumerated(CONVERSATION_KINDS).default('direct'),
    /** Null for a direct thread: its name is whoever else is in it. */
    title: text({ max: 120 }).nullable(),
    createdAt: timestamp().defaultNow(),
  },
});

export type Conversation = typeof conversations.$row;
