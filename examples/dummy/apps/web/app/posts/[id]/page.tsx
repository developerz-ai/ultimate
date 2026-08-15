/**
 * One post, for its own org. `ssr` rather than `stream`: the page is one query, and an author
 * arriving from the editor must never see a cached draft body. Caching a per-request render is a
 * correctness bug, so `offline` is `network-only` with the fallback route behind it.
 */

import { useT } from '@postly/i18n';
import { defineRoute } from '@ultimat3/render';
import { Button, DateTime, Stack, Text } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { For, Show } from 'solid-js';
import { useActor, useCan } from '../../../shared/actor';
import { client, queries } from '../../../shared/client';
import { oneRow } from '../../../shared/rows';
import { wireDate } from '../../../shared/wire';
import { Layout } from '../../layout';
import { useViewer } from '../../viewer-context';
import { LikeButton } from '../ui/like-button';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'ssr',
  offline: 'network-only',
  hydrate: 'interaction',
  budget: { js: '40kb', lcp: 2000 },
  /**
   * `postById` is a read, so it comes off the query client — `client` posts actions, and the two
   * registries are separate keys on `Api` precisely so this cannot be confused.
   *
   * The org is required input, not an optional filter: `postRead` decides on it, and a
   * tenant-columned read that names no org is `X_TENANCY_UNSCOPED`. It comes off the actor rather
   * than the URL because `/posts/{id}` carries no tenant and an id from another org must read as
   * absent, which is exactly what an org-scoped read of a foreign id answers.
   */
  load: async ({ params }) => {
    const postId = params.id ?? '';
    const post = oneRow(await queries.postById({ orgId: useActor().orgId, postId }), postId);
    // Both instants are rehydrated here, where the wire ends: the read answered JSON, so what
    // `<DateTime>` would otherwise be handed is the ISO string, not the `Date` the row type says.
    return {
      ...post,
      publishedAt: wireDate(post.publishedAt),
      comments: post.comments.map((comment) => ({
        ...comment,
        createdAt: wireDate(comment.createdAt),
      })),
    };
  },
  meta: ({ data, t }) => ({
    title: t('app.post.metaTitle', { title: data.title }),
    description: data.excerpt,
    robots: { index: false },
  }),
});

/** The row the loader unwrapped, not the page of rows the read answered. */
type PostPage = Awaited<ReturnType<typeof queries.postById>>[number];

export function Page(props: { readonly data: PostPage }): JSX.Element {
  const t = useT();
  const viewer = useViewer();

  /**
   * The permission half of the same `post:publish` rule the action enforces, so the button is
   * absent for anyone who holds nothing. The rule's OTHER half is authorship, which is decided
   * against the post row the browser does not have — `publishPost` re-decides with it on every
   * call, and that decision, not this one, is the authoritative answer.
   */
  const canPublish = useCan('post:publish');

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
            <Show when={props.data.status === 'draft' && canPublish}>
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
          {/* `postRead` decides on the org, so it travels in the input — including on the
              pre-hydration path, which would otherwise fail the action's own schema. */}
          <input type="hidden" name="orgId" value={props.data.orgId} />
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
