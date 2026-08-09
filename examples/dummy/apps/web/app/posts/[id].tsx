/**
 * One post, for its own org. `ssr` rather than `stream`: the page is one query, and an author
 * arriving from the editor must never see a cached draft body. Caching a per-request render is a
 * correctness bug, so `offline` is `network-only` with the fallback route behind it.
 */

import { useT } from '@postly/i18n';
import { usePolicy } from '@ultimat3/policy';
import { defineRoute } from '@ultimat3/render';
import { Button, DateTime, Stack, Text } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { For, Show } from 'solid-js';
import { client } from '../../shared/client';
import { Layout } from '../layout';
import { useViewer } from '../viewer-context';
import styles from './post.module.scss';
import { LikeButton } from './ui/like-button';

export const config = defineRoute({
  render: 'ssr',
  offline: 'network-only',
  hydrate: 'interaction',
  budget: { js: '40kb', lcp: 2000 },
  load: ({ params }) => client.postById({ postId: params.id }),
  meta: ({ data, t }) => ({
    title: t('app.post.metaTitle', { title: data.title }),
    description: data.excerpt,
    robots: 'noindex',
  }),
});

type PostPage = Awaited<ReturnType<typeof client.postById>>;

export function Page(props: { readonly data: PostPage }): JSX.Element {
  const t = useT();
  const viewer = useViewer();

  /**
   * The same `post:publish` rule the action enforces, evaluated for rendering. One definition,
   * so the button cannot appear for someone the server would deny — or hide from someone it
   * would allow.
   */
  const canPublish = usePolicy('post:publish', () => ({ postId: props.data.id }));

  return (
    <Layout>
      <article class={styles.article}>
        <Stack gap="4">
          <h1>{props.data.title}</h1>

          <Show when={props.data.status === 'draft'}>
            <p class={styles.draft}>{t('app.post.draftNotice')}</p>
          </Show>

          <p class={styles.meta}>
            {t('site.blog.by', { name: props.data.authorName })}
            <Show when={props.data.publishedAt}>
              {(publishedAt) => <DateTime value={publishedAt()} zone={viewer.zone} format="long" />}
            </Show>
          </p>

          <div class={styles.body}>{props.data.body}</div>

          <div class={styles.actions}>
            <LikeButton
              postId={props.data.id}
              orgId={props.data.orgId}
              likeCount={props.data.likeCount}
            />
            <Show when={props.data.status === 'draft' && canPublish()}>
              <Button
                onClick={() =>
                  client.publishPost({ postId: props.data.id, orgId: props.data.orgId })
                }
              >
                {t('app.post.publish')}
              </Button>
            </Show>
          </div>
        </Stack>
      </article>

      <section class={styles.comments}>
        <h2>{t('app.post.commentsHeading')}</h2>

        <Show
          when={props.data.comments.length > 0}
          fallback={<Text tone="muted">{t('app.post.commentsEmpty')}</Text>}
        >
          <ul class={styles.list}>
            <For each={props.data.comments}>
              {(comment) => (
                <li>
                  <Text>{comment.body}</Text>
                  <DateTime value={comment.createdAt} zone={viewer.zone} format="relative" />
                </li>
              )}
            </For>
          </ul>
        </Show>

        {/* Native form posting to the action's generated route: it works before hydration. */}
        <form class={styles.form} method="post" action="/_x/action/create-comment">
          <input type="hidden" name="postId" value={props.data.id} />
          <label class={styles.label} for="comment-body">
            {t('app.post.commentsHeading')}
          </label>
          <textarea
            id="comment-body"
            name="body"
            placeholder={t('app.post.commentPlaceholder')}
            required
          />
          <Button type="submit">{t('app.post.commentSubmit')}</Button>
        </form>
      </section>
    </Layout>
  );
}
