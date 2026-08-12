// One post, wherever it appears. The feed lists posts by many people and a profile lists posts by
// one, so the byline's author half is optional — but the card, the measure, the metrics and the
// hover are the same object, which is what stops the two screens drifting into two designs.
//
// Presentational only: the caller formats the date, because a date is never formatted without an
// explicit IANA zone and only the caller knows which one this render is in.

import { t } from '@ultimat3/i18n';
import { Icon } from '@ultimat3/ui';
import { iconHeart } from '@ultimat3/ui/icons/heart';
import { iconMessageCircle } from '@ultimat3/ui/icons/message-circle';
import type { JSX } from 'solid-js';
import styles from './post-card.module.scss';

export interface PostCardAuthor {
  readonly name: string;
  readonly handle: string;
}

export interface PostCardProps {
  /** Omitted on a profile, where every post has the same author and the byline would repeat it. */
  readonly author?: PostCardAuthor | undefined;
  readonly body: string;
  /** Machine-readable instant for `<time datetime>`. */
  readonly publishedAt: Date;
  /** The same instant, already formatted in the render's own zone. */
  readonly published: string;
  readonly likeCount: number;
  readonly commentCount: number;
}

/** First character of the display name. Decorative — the name itself is right beside it. */
const initialOf = (name: string): string => (name.at(0) ?? '').toUpperCase();

export function PostCard(props: PostCardProps): JSX.Element {
  const author = props.author;

  return (
    <article class={styles.card}>
      <header class={styles.byline}>
        {author === undefined ? null : (
          <>
            <span class={styles.avatar} aria-hidden="true">
              {initialOf(author.name)}
            </span>
            <a class={styles.name} href={`/u/${author.handle}`}>
              {author.name}
            </a>
            <span class={styles.handle}>@{author.handle}</span>
            <span class={styles.dot} aria-hidden="true">
              ·
            </span>
          </>
        )}
        <time class={styles.when} datetime={props.publishedAt.toISOString()}>
          {props.published}
        </time>
      </header>

      <p class={styles.body}>{props.body}</p>

      <footer class={styles.metrics}>
        <span class={styles.metric}>
          <Icon glyph={iconHeart} />
          {t('site.feed.likes', { count: props.likeCount })}
        </span>
        <span class={styles.metric}>
          <Icon glyph={iconMessageCircle} />
          {t('site.feed.comments', { count: props.commentCount })}
        </span>
      </footer>
    </article>
  );
}
