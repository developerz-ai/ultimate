/**
 * The one interactive island on a post. It calls the mutator and nothing else: the optimistic
 * update, the offline queue and the reconciliation belong to the mutator, not to this component.
 */

import { useT } from '@postly/i18n';
import { useConnection, useMutation } from '@ultimat3/realtime';
import { Button } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { Show } from 'solid-js';
import { toggleLike } from '../mutator';
import styles from './like-button.module.scss';

export type LikeButtonProps = {
  readonly postId: string;
  /** Comes from the live query's row, so it is already the optimistic value while queued. */
  readonly likeCount: number;
};

export const LikeButton = (props: LikeButtonProps): JSX.Element => {
  const t = useT();
  const like = useMutation(toggleLike);
  const connection = useConnection();

  return (
    <div class={styles.row}>
      <Button tone="ghost" onClick={() => like({ postId: props.postId })}>
        {t('app.post.like')}
      </Button>

      <span class={styles.count}>{t('app.post.likes', { count: props.likeCount })}</span>

      {/* The queue is durable, so this is information, not an error. */}
      <Show when={connection.offline && like.pending > 0}>
        <span class={styles.queued}>{t('errors.offlineQueued')}</span>
      </Show>
    </div>
  );
};
