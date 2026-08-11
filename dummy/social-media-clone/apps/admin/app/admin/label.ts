// The one rendering of "who am I acting as". Five screens print it; one function means they cannot
// disagree about whether an anonymous caller reads as "anonymous" or as an empty string.

import { t } from '@ultimat3/i18n';
import { currentAdminActor } from './actor';

export const actorLabel = (): string => {
  const { actor } = currentAdminActor();
  return actor === null
    ? t('admin.actor.anonymous')
    : t('admin.actor.signedIn', { id: actor.id, roles: (actor.roles ?? []).join(', ') });
};
