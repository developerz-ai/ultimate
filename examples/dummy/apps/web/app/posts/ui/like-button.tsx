/**
 * The one interactive island on a post. It calls the mutator and nothing else: the optimistic
 * update, the offline queue and the reconciliation belong to the mutator, not to this component.
 */

import { useT } from '@postly/i18n';
import { useConnection, useMutation } from '@ultimat3/realtime';
import { Button } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { Show } from 'solid-js';
import { likePost } from '../mutator';
import styles from './like-button.module.scss';

export type LikeButtonProps = {
  readonly postId: string;
  /**
   * The post's org, because `postLike` decides on it. It rides in the mutator's input rather than
   * being read off the session inside the handler: a policy decides on what it was given, and the
   * same input has to reach the rule from an offline queue replayed hours later.
   */
  readonly orgId: string;
  /** Comes from the live query's row, so it is already the optimistic value while queued. */
  readonly likeCount: number;
};

export const LikeButton = (props: LikeButtonProps): JSX.Element => {
  const t = useT();
  const like = useMutation(likePost);
  const connection = useConnection();

  return (
    <div class={styles.row}>
      {/* `ghost` is a BUTTON VARIANT, never a tone: `Tone` is the status colour scale. */}
      <Button variant="ghost" onClick={() => like({ postId: props.postId, orgId: props.orgId })}>
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
