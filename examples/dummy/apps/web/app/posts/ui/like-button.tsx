/**
 * The like control as the SERVER can render it: the count it knows, and a button it cannot honour.
 *
 * It held `useMutation()` and `useConnection()` until 2026-08-25, on a route that declared no
 * `island()` — so no module of it ever ran in a browser, every click went nowhere and the queued
 * badge could not appear (`X_LIVE_ROUTE_NO_ISLAND`). The interactive half is now
 * `[id]/like.island.tsx`, which replaces this markup once a browser has booted it; this file is the
 * shell inside the island's wrapper, and the same `.module.scss` styles both.
 *
 * The button is `disabled` rather than wired to the mutator's HTTP twin, and that is the honest
 * statement: a like is applied through the socket the island opens, so before the island there is
 * nothing behind it to press.
 */

import { useT } from '@postly/i18n';
import type { JSX } from 'solid-js';
import styles from './like-button.module.scss';

export type LikeButtonProps = {
  /** Comes from the read the page already made — the same value the island is handed, once. */
  readonly likeCount: number;
};

export const LikeButton = (props: LikeButtonProps): JSX.Element => {
  const t = useT();

  return (
    <div class={styles.row}>
      <button class={styles.button} type="button" disabled>
        {t('app.post.like')}
      </button>
      <span class={styles.count}>{t('app.post.likes', { count: props.likeCount })}</span>
    </div>
  );
};
