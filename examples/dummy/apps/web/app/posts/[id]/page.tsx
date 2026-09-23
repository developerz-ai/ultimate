/**
 * One post, for its own org. `ssr` rather than `stream`: the page is one query.
 *
 * `offline: 'runtime'` — network first, the device's copy only when the network fails — so a post
 * read once opens again in a tunnel, which is what the offline like on this page is for. A render
 * cached on the device is one principal's view, and it can only ever be shown to that principal:
 * sign-out (`endSession`, `app/auth/actions.ts`) answers `Clear-Site-Data: "cache", "storage"`,
 * which drops the service worker's caches, and the page boot wipes any other principal's stored
 * record scopes before it reads one. It was `network-only` while neither was true.
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
import { memberQueries } from '../../../shared/client';
import { pluralFormsOf } from '../../../shared/plural-forms';
import { oneRow } from '../../../shared/rows';
import { wireDate } from '../../../shared/wire';
import { Layout, updateBannerIsland } from '../../layout';
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

/** `publishPost` → `POST /api/posts/publish`, by the same rule and for the same reason. */
const PUBLISH_ENDPOINT = derivePath('publishPost' satisfies keyof Api['actions']).path;

/**
 * The page's two islands, declared ABOVE `defineRoute` so the route can drain them. `props` are the
 * exact keys the browser receives, as JSON and already translated: a catalog cannot cross the wire
 * and neither can a callback. Both show `posts:<id>` — the header badge and the control read ONE
 * record out of the page's store, so a like moves both (plan 101: one record, many places).
 *
 * Named `like.island.tsx` and not `[id].island.tsx`: the two precedents name an island after their
 * directory because there the directory IS the feature, and this one is a route parameter —
 * `islandModuleId` would reduce it to `id`, and the brackets are metacharacters to every glob the
 * toolchain hands a path to.
 */
const Like = island({
  src: './like.island.tsx',
  props: ['postId', 'orgId', 'likeCount', 'labels'],
});

const LikesBadge = island({
  src: './likes-badge.island.tsx',
  props: ['postId', 'likeCount', 'likes'],
});

/** The layout's update banner — an island of THIS route, so it is declared here. */
const Banner = updateBannerIsland('../../update-banner.island.tsx');

export const config = defineRoute({
  render: 'ssr',
  /**
   * A post — including a draft — is org-only, so the route declares the gate. Without a `policy`
   * the route registers as `auth: 'public'` and the render skips its gated branch, which is a
   * per-member page with no `vary: cookie` on it. The row-level half stays with `postRead`, which
   * `postById` evaluates against the org this page reads under.
   */
  policy: { permission: 'post:read' satisfies KnownPermission },
  offline: 'runtime',
  /**
   * `idle`, decided on BEHAVIOUR, and the bytes agree it is close to free: the `idle` runtime is
   * 1,744 B against `interaction`'s 1,629 (measured 2026-09-22, `hydrateRuntimeBytes`) — 115 B.
   *
   * Both now catch a click on the server's markup before the chunk arrives and replay it once the
   * island mounts (`catchUp` in `packages/render/src/hydrate.ts`, re-aimed at whatever is under
   * the pointer when the shell was replaced) — which is why `ui/like-button.tsx`'s button is no
   * longer `disabled`. So the first press is safe either way, and that is no longer the argument.
   *
   * The argument is that this page is LIVE before anyone touches it. The like control subscribes
   * the org's `posts` channel, so a like from another tab or another member moves both counts with
   * no click here ("one record, many places"); `interaction` would boot nothing until the reader
   * pressed something, and every like elsewhere would be invisible until then. 115 B buys that.
   */
  hydrate: 'idle',
  /**
   * measured: 137,060 B (2026-09-22; `x build`'s `buildIslands`, `buildPageBoot`,
   * `hydrateRuntimeBytes`) — the like control 78,050 + the header's count 26,927 + the update
   * banner 712 + the page boot 29,627 + the `idle` runtime 1,744, against 137,216.
   * Counted the way the `budgets` step sums a document (`packages/cli/src/budgets.ts`): every
   * executable `<script src>` it carries — the page boot included, only `/x-sw-register.js` is
   * exempt (`FRAMEWORK_SCRIPTS`) — plus every island chunk and the inline hydration runtime.
   * why: "one record, many places" — two islands read `posts:<id>` from the page's store, and a
   * like is optimistic, survives a reload offline and replays once (`posts` is `persist: true`);
   * the like control also carries the socket's "a new build is live" notice, and the layout's
   * banner — the service worker's half — is its own 712 B island. Each island is its own bundle
   * (`splitting: false`, plan 101 decision 12), so each carries its own copy of the page's
   * realtime — 26,444 B of the header's count is the like control's too. Down from 145,000 when
   * the outbox left the like control for the page boot (7,940 B); the shared runtime is #505, and
   * this number comes DOWN again when it lands.
   */
  budget: { js: '134kb', lcp: 2000 },
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
    const post = oneRow(await memberQueries.postById({ orgId: useActor().orgId, postId }), postId);
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
type PostPage = Awaited<ReturnType<typeof memberQueries.postById>>[number];

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
  /** Every plural form of the count, for both islands: the count they show can be any number. */
  const likes = pluralFormsOf(t, 'app.post.likes');

  return (
    <Layout banner={Banner}>
      <article class={styles.article}>
        <Stack gap={4}>
          <h1>{props.data.title}</h1>

          <Show when={props.data.status === 'draft'}>
            <p class={styles.draft}>{t('app.post.draftNotice')}</p>
          </Show>

          <p class={styles.meta}>
            {t('site.blog.by', { name: props.data.authorName })}
            {/* The header's count: the same record the like control below writes. */}
            <LikesBadge postId={props.data.id} likeCount={props.data.likeCount} likes={likes}>
              <span>{t('app.post.likes', { count: props.data.likeCount })}</span>
            </LikesBadge>
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
              likeCount={props.data.likeCount}
              labels={{
                like: t('app.post.like'),
                likes,
                queued: t('errors.offlineQueued'),
                update: t('errors.updateAvailable'),
                reload: t('errors.updateAction'),
              }}
            >
              <LikeButton likeCount={props.data.likeCount} />
            </Like>
            {/*
              A native form, not an `onClick`: this page is server-rendered and ships no island for
              it, so a handler here never reached a browser and the button did nothing (plan 101,
              slice 16). The form posts to the action's derived route and works with scripting off,
              the same shape as the comment form below — and costs the route zero bytes.
            */}
            <Show when={props.data.status === 'draft' && canPublish}>
              <form method="post" action={PUBLISH_ENDPOINT}>
                <input type="hidden" name="postId" value={props.data.id} />
                <input type="hidden" name="orgId" value={props.data.orgId} />
                <Button type="submit">{t('app.post.publish')}</Button>
              </form>
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
