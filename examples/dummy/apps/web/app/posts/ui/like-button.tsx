/**
 * The like control as the SERVER can render it: the count it knows, and a button it cannot honour.
 *
 * It held `useMutation()` and `useConnection()` until 2026-08-25, on a route that declared no
 * `island()` — so no module of it ever ran in a browser, every click went nowhere and the queued
 * badge could not appear (`X_LIVE_ROUTE_NO_ISLAND`). The interactive half is now
 * `[id]/like.island.tsx`, which replaces this markup once a browser has booted it; this file is the
 * shell inside the island's wrapper, and the same `.module.scss` styles both.
 *
 * The button is live, not `disabled`: a like is an HTTP write (`useMutation` POSTs the mutator's
 * action), and a click that lands before the island has booted is captured by the hydration
 * runtime and replayed onto the island's own button once it mounts (`@ultimat3/render`'s
 * `hydrate.ts`, which re-aims at whatever is under the pointer when the shell was replaced). A
 * `disabled` button swallowed that first press instead.
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
      <button class={styles.button} type="button">
        {t('app.post.like')}
      </button>
      <span class={styles.count}>{t('app.post.likes', { count: props.likeCount })}</span>
    </div>
  );
};
