// The one refusal this feature owns. A row in `participants` IS the grant, so "not in this thread"
// is the only denial messages can produce — and it is the SAME answer whether the conversation is
// missing or merely not yours, because telling those two apart turns the thread table into
// something an outsider can enumerate one id at a time. So it is a 404 either way.

import { defineError } from '@ultimat3/core/page';

export interface NotAParticipantInit {
  readonly conversationId: string;
  /** `null` for a signed-out caller — reported as such, never as a made-up id. */
  readonly actorId: string | null;
}

export const NotAParticipantError = defineError<NotAParticipantInit>({
  code: 'X_NOT_A_PARTICIPANT',
  title: 'the actor is not in this conversation',
  status: 404,
  cause: (init) =>
    `${init.actorId ?? 'an anonymous caller'} has no participants row for conversation ${init.conversationId}, and a missing conversation answers the same way on purpose`,
  fix: 'add the user to the thread with addParticipant() in apps/web/app/messages/repo.ts — membership is the only grant there is',
  meta: (init) => ({ conversationId: init.conversationId, actorId: init.actorId }),
});
