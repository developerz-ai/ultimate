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
 * One notification per other participant, in ONE statement. The row is the fact and the badge
 * counts rows, so the shape is the same whether this runs here or in a job — but the loop that
 * awaited an insert per member made a message to a full 100-person conversation 99 sequential
 * round trips inside the request that sent it, and the person waiting for those was the sender.
 */
async function notifyOthers(
  conversationId: string,
  authorId: string,
  messageId: string,
): Promise<void> {
  const members = await repo.membersOf(conversationId);
  await notifications.insertNotifications(
    members
      .filter((member) => member.userId !== authorId)
      .map((member) => ({
        userId: member.userId,
        kind: 'message' as const,
        actorId: authorId,
        subjectId: messageId,
      })),
  );
}
