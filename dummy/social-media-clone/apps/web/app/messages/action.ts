// Sending a message. An `action`, not a mutator: a sent message is not convergent — replaying it
// produces a SECOND message, because two identical lines a second apart are a real thing a person
// does. Nothing here may be replayed by a rebase, so there is no local twin to write.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.

import { BODY_MAX } from '@social-media-clone/domain';
import { action, actorOf, t } from '@ultimat3/action';
import * as notifications from '../notifications/repo';
import { messageSend } from './policy';
import * as repo from './repo';

export const sendMessage = action({
  input: t.object({
    conversationId: t.uuid,
    // Bounded, but NOT trimmed or minimum-length checked here: `messages.message_body_present` is
    // the one declaration of "a message has something in it", enforced in the app on every write
    // and as a Postgres CHECK. A `min(1)` here would be a second, weaker copy that passes for a
    // body of three spaces.
    body: t.string.max(BODY_MAX),
  }),
  output: t.object({
    id: t.uuid,
    conversationId: t.uuid,
    authorId: t.uuid,
    body: t.string,
    createdAt: t.date,
  }),
  policy: messageSend,
  // The membership fact, loaded once, after the input parse and before the guard. The predicate
  // stays synchronous; this is the async half authz is not allowed to have.
  async row({ input }) {
    return repo.threadRowOf(input.conversationId);
  },
  mcp: { expose: true, description: 'Send a message to a conversation the actor is already in' },
  async handle({ input, ctx }) {
    // `messageSend` refused a null actor before this ran (`can()` answers X_UNAUTHENTICATED for
    // one), so this is a real member of the thread and not the anonymous placeholder.
    const author = actorOf(ctx);
    const authorId = author?.id ?? '';
    const message = await repo.insertMessage({
      conversationId: input.conversationId,
      authorId,
      body: input.body,
    });
    await notifyOthers(input.conversationId, authorId, message.id);
    return message;
  },
});

/**
 * One notification per other participant. Written here rather than in a job because the demo runs
 * every role in one process; the shape is the same either way — the row is the fact, and the badge
 * counts rows.
 */
async function notifyOthers(
  conversationId: string,
  authorId: string,
  messageId: string,
): Promise<void> {
  for (const member of await repo.membersOf(conversationId)) {
    if (member.userId === authorId) continue;
    await notifications.insertNotification({
      userId: member.userId,
      kind: 'message',
      actorId: authorId,
      subjectId: messageId,
    });
  }
}
