/**
 * One post, for its own org. `ssr` rather than `stream`: the page is one query, and an author
 * arriving from the editor must never see a cached draft body. Caching a per-request render is a
 * correctness bug, so `offline` is `network-only` with the fallback route behind it.
 */

import { useT } from '@postly/i18n';
import { derivePath } from '@ultimat3/action';
import type { KnownPermission } from '@ultimat3/policy';
import { defineRoute, island } from '@ultimat3/render';
import { Button, DateTime, RelativeTime, Stack, Text } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { For, Show } from 'solid-js';
import type { Api } from '../../../api';
import { useActor, useCan } from '../../../shared/actor';
import { client, queries } from '../../../shared/client';
import { oneRow } from '../../../shared/rows';
import { syncUrlFrom } from '../../../shared/sync-url';
import { wireDate } from '../../../shared/wire';
import { Layout } from '../../layout';
import { useViewer } from '../../viewer-context';
import { LikeButton } from '../ui/like-button';
import styles from './page.module.scss';

/**
 * The action the comment form posts to, named once and checked by the compiler — the same rule
 * `site/pricing/page.tsx` follows, and `import type` keeps `app/`'s runtime edge into `api/`
 * absent. `createComment` → `POST /api/comments/create`; this file said `/_x/action/create-comment`
 * until 2026-08, a path `derivePath` has never minted and nothing mounts.
 */
const COMMENT_ACTION = 'createComment' satisfies keyof Api['actions'];
const COMMENT_ENDPOINT = derivePath(COMMENT_ACTION).path;

/**
 * The page's one island, declared ABOVE `defineRoute` so the route can drain it — the same shape
 * `/feed` and `/settings` use. `props` are the exact keys the browser receives, as JSON and
 * already translated: a catalog cannot cross the wire and neither can a callback.
 *
 * Named `like.island.tsx` and not `[id].island.tsx`: the two precedents name an island after their
 * directory because there the directory IS the feature, and this one is a route parameter —
 * `islandModuleId` would reduce it to `id`, and the brackets are metacharacters to every glob the
 * toolchain hands a path to.
 */
const Like = island({
  src: './like.island.tsx',
  props: ['postId', 'orgId', 'syncUrl', 'buildId', 'actorId', 'labels'],
});

export const config = defineRoute({
  render: 'ssr',
  /**
   * A post — including a draft — is org-only, so the route declares the gate. Without a `policy`
   * the route registers as `auth: 'public'` and the render skips its gated branch, which is a
   * per-member page with no `vary: cookie` on it. The row-level half stays with `postRead`, which
   * `postById` evaluates against the org this page reads under.
   */
  policy: { permission: 'post:read' satisfies KnownPermission },
  offline: 'network-only',
  /**
   * `idle`, and the reason this line used to give is no longer true.
   *
   * It said the interaction runtime replays the waking event with `ev.target.dispatchEvent(...)`
   * onto a node this island's `mount` had already detached — the "the button does nothing on the
   * first press" failure. That WAS the defect, and it was fixed on 2026-08-25: the runtime now
   * re-aims (`aim()` in `packages/render/src/hydrate.ts`) at the original target when it survived
   * the mount, else at whatever the hit test finds under the pointer, else at the island root.
   *
   * It also claimed "every island's `mount` clears the wrapper first", which was never true —
   * `site/pricing/contact-sales.island.tsx` deliberately takes the server's own `<form>` over
   * instead, and it is the one island in this app that actually derives `interaction`.
   *
   * So `interaction` is available here now, and `idle` is a BUDGET choice rather than a
   * correctness one: the interaction runtime is 1,251 bytes against `idle`'s 774, which would
   * put this route at 47,909 of 51,200. Re-measure before switching — do not adjust the numbers
   * in the comment below by arithmetic.
   */
  hydrate: 'idle',
  /**
   * Measured 2026-08-25, not guessed: the island chunk is 46,658 bytes (`buildIslands` in
   * `like.island.test.ts` reports it) plus the 774-byte `idle` hydration runtime
   * (`hydrateRuntimeBytes`), so 47,432 against 51,200. Re-measure rather than adjust, and expect
   * the chunk to move by up to the 512-byte shaker flap `island-bytes.test.ts` records: this
   * island reaches `@ultimat3/realtime`. Nearly all of it is the Solid runtime, `LiveClient` and
   * `OfflineQueue`; the control's own compiled markup is a few hundred bytes, which is why this
   * island renders plain elements rather than `@ultimat3/ui`'s `Button` — that component alone
   * costs more than the headroom left here.
   */
  budget: { js: '50kb', lcp: 2000 },
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
  const actor = useActor();

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
        <Stack gap={4}>
          <h1>{props.data.title}</h1>

          <Show when={props.data.status === 'draft'}>
            <p class={styles.draft}>{t('app.post.draftNotice')}</p>
          </Show>

          <p class={styles.meta}>
            {t('site.blog.by', { name: props.data.authorName })}
            <Show when={props.data.publishedAt}>
              {(publishedAt) => (
                <DateTime value={publishedAt()} timeZone={viewer.zone} dateStyle="long" />
              )}
            </Show>
          </p>

          <div class={styles.body}>{props.data.body}</div>

          <div class={styles.actions}>
            {/*
              The island's wrapper, and what the server puts inside it: the count it already read
              and a button it cannot honour, which `mount` replaces with the one that can.
            */}
            <Like
              postId={props.data.id}
              orgId={props.data.orgId}
              syncUrl={syncUrlFrom(process.env)}
              buildId={process.env['BUILD_ID'] ?? 'dev'}
              actorId={actor.id}
              labels={{
                like: t('app.post.like'),
                count: t('app.post.likes', { count: props.data.likeCount }),
                queued: t('errors.offlineQueued'),
              }}
            >
              <LikeButton likeCount={props.data.likeCount} />
            </Like>
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
                  <RelativeTime value={comment.createdAt} timeZone={viewer.zone} />
                </li>
              )}
            </For>
          </ul>
        </Show>

        {/* Native form posting to the action's generated route: it works before hydration. */}
        <form class={styles.form} method="post" action={COMMENT_ENDPOINT}>
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
