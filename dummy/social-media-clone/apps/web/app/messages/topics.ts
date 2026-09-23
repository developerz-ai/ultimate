// The chat channel: one per conversation, and who may join it.
//
// A `channel()` declaration since 21.0.0, not a topic string plus a guard. Membership is checked
// for real: the declaration's `row` loader reads the participants row, and `threadRead` — the same
// synchronous policy the page, the action and the live query evaluate — decides on it. A committed
// `messages` row reaches every member as a record, routed by its own `conversationId`.

import { schema } from '@social-media-clone/db';
import { channel } from '@ultimat3/realtime';
import { liveThread } from './live';
import { threadRead } from './policy';
import * as repo from './repo';

export const conversationChannel = channel('messages', {
  params: ['conversationId'],
  /**
   * Identical refusal for "no such conversation" and "not yours", deliberately: a reason that told
   * the two apart would let a socket enumerate the id space one subscribe at a time. An empty
   * participants list is what an absent conversation loads as, and `threadRead` denies it.
   */
  policy: threadRead,
  row: ({ params }) => repo.threadRowOf(params['conversationId'] ?? ''),
  catchUp: liveThread,
  records: [schema.messages],
});
