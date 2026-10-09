// The friends slice's action outputs, shared by its actions: what a friendship and a block
// answer as, and the person row both name.

import { FRIENDSHIP_STATUSES } from '@social-media-clone/domain';
import { t } from '@ultimat3/action';
import type { PersonRow } from './policy';
import { personById } from './repo';

/** The row shape every friendship command answers with. Derived from the entity's own columns. */
export const FriendshipView = t.object({
  requesterId: t.uuid,
  addresseeId: t.uuid,
  status: t.enumerated(...FRIENDSHIP_STATUSES),
  respondedAt: t.nullable(t.date),
  createdAt: t.date,
});

export const BlockView = t.object({ blockerId: t.uuid, blockedId: t.uuid, createdAt: t.date });

/**
 * The loader narrows to exactly what the rule reads. Handing the whole `User` row to a policy would
 * put a bio and an email inside an authz decision, and a denial `reason` is allowed to name a
 * permission but never row data.
 */
export const personRow = async ({
  input,
}: {
  input: { userId: string };
}): Promise<PersonRow | null> => {
  const person = await personById(input.userId);
  return person === null ? null : { id: person.id };
};
