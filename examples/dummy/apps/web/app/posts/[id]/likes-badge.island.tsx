/**
 * The post's like count in its header — the SECOND island on `/posts/{id}` showing the same record.
 *
 * It reads `posts:<id>` out of the page's one store and nothing else: no read, no channel, no
 * socket. The like control below it seeds and subscribes that record, so a click there, a like in
 * another tab, or the overlay a refused write takes back all move this number too, with no message
 * between the two islands — they hold one object, not two copies. That is plan 101's "one record,
 * many places", and `useRecord` alone is why this chunk ships none of the connection lifecycle.
 */

import { useRecord } from '@ultimat3/realtime';
import type { JSX } from 'solid-js';
import { onCleanup } from 'solid-js';
import { render } from 'solid-js/web';
import { type PluralForms, pluralText } from '../../../shared/plural-text';
import type { PostRecord } from '../channel-ref';

export interface LikesBadgeProps {
  readonly postId: string;
  /** The server's count: what shows until the record lands. */
  readonly likeCount: number;
  readonly likes: PluralForms;
}

function LikesBadge(props: LikesBadgeProps): JSX.Element {
  const post = useRecord<PostRecord>('posts', props.postId);
  onCleanup(post.release);
  const count = (): number => {
    const state = post();
    return state.status === 'ready' || state.status === 'refreshing'
      ? (state.data?.likeCount ?? props.likeCount)
      : props.likeCount;
  };
  return (
    <span data-role="likes-badge" data-like-count={count()} data-post={props.postId}>
      {pluralText(props.likes, count())}
    </span>
  );
}

export function mount(el: HTMLElement, props: LikesBadgeProps): void {
  el.textContent = '';
  render(() => <LikesBadge {...props} />, el);
}
