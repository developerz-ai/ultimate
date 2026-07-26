/**
 * The post summary card. Presentational: it receives a post and the viewer's zone, and renders.
 * Interactivity arrives through the `actions` slot so the static blog never pulls in a mutator.
 */

import type { PostStatus } from '@postly/domain';
import { useT } from '@postly/i18n';
import { Badge, Card, DateTime, Stack, Text } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { Show } from 'solid-js';
import styles from './post-card.module.scss';

export type PostCardPost = {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string;
  readonly status: PostStatus;
  readonly likeCount: number;
  readonly publishedAt: Date | null;
  readonly authorName: string;
};

export type PostCardProps = {
  readonly post: PostCardPost;
  readonly href: string;
  /** IANA zone of the viewer, not the server. Required, so it cannot be forgotten. */
  readonly zone: string;
  readonly actions?: JSX.Element;
};

export const PostCard = (props: PostCardProps): JSX.Element => {
  const t = useT();

  return (
    <Card class={styles.card}>
      <Stack gap="3">
        <Show when={props.post.status !== 'published'}>
          <Badge tone="warning">{t(`posts.status.${props.post.status}`)}</Badge>
        </Show>

        <a class={styles.title} href={props.href}>
          {props.post.title}
        </a>

        <Text tone="muted">{props.post.excerpt}</Text>

        <div class={styles.meta}>
          <span>{t('site.blog.by', { name: props.post.authorName })}</span>
          <Show when={props.post.publishedAt}>
            {(publishedAt) => <DateTime value={publishedAt()} zone={props.zone} format="date" />}
          </Show>
          <span>{t('app.post.likes', { count: props.post.likeCount })}</span>
        </div>

        <Show when={props.actions}>
          <div class={styles.actions}>{props.actions}</div>
        </Show>
      </Stack>
    </Card>
  );
};
