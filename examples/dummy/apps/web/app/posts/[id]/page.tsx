/**
 * One post, for its own org. `ssr` rather than `stream`: the page is one query.
 *
 * `offline: 'runtime'` — network first, the device's copy only when the network fails — so a post
 * read once opens again in a tunnel, which is what the offline like on this page is for. A render
 * cached on the device is one principal's view, and it can only ever be shown to that principal:
 * sign-out (`endSession`, `app/auth/actions/end-session.ts`) answers `Clear-Site-Data: "cache", "storage"`,
 * which drops the service worker's caches, and the page boot wipes any other principal's stored
 * record scopes before it reads one. It was `network-only` while neither was true.
 */

import { excerptOf } from '@postly/domain';
import { useT } from '@postly/i18n';
import { actionHttpPath, derivePath } from '@ultimat3/action';
import type { KnownPermission } from '@ultimat3/policy';
import { defineRoute, island } from '@ultimat3/render';
import {
  allLanguages,
  Button,
  ConfirmDialog,
  DateTime,
  DiffView,
  Markdown,
  RelativeTime,
  Stack,
  Text,
  Timeline,
} from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { Show } from 'solid-js';
import type { Api } from '../../../api';
import { useActor, useCan } from '../../../shared/actor';
import { memberQueries } from '../../../shared/client';
import { pluralFormsOf } from '../../../shared/plural-forms';
import { oneRow } from '../../../shared/rows';
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

/**
 * `publishPost` pins `POST /api/posts/:postId/publish`, so its URL names the post — filled per
 * render from the row (`actionHttpPath`), never a module-level const: a template has no one URL.
 */
const PUBLISH_ACTION = 'publishPost' satisfies keyof Api['actions'];

/**
 * `withdrawPost` keeps its derived path, `POST /api/posts/withdraw`: the post travels in the body.
 * The write that takes a public page DOWN, so it is asked through `ConfirmDialog` — Cancel holds
 * focus, the backdrop never dismisses, and the form inside posts natively with scripting off.
 */
const WITHDRAW_ENDPOINT = derivePath('withdrawPost' satisfies keyof Api['actions']).path;

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

/**
 * `summarize` read as it is written: an `llm()` declares `stream`, so the island asks the action's
 * own route for `text/event-stream` and shows each token as it lands (`summary.island.tsx`).
 */
const Summary = island({
  src: './summary.island.tsx',
  props: ['postId', 'orgId', 'writingLabel', 'failedLabel'],
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
   *
   * measured: 155,790 B (2026-09-28: 137,060 above + the router 18,276 + 40 in the runtime + 207
   * in each of the two islands that reach core's transport, each measured by
   * `x build --target static` on `/posts/new`, `/settings` and `/feed` — a dynamic route that build
   * does not prerender), against 156,160 (`152.5kb`).
   * why: client navigation (`navigation: { client: ['app'] }` in `app.config.ts`) — the router,
   * `/_x/navigation/<hash>.js`, 18,276 B on every `app/` document, charged like the page boot: it
   * is interactivity this app opted into, and a route cannot remove it; `/settings`' reason for the island bytes.
   *
   * measured: 156,585 B (2026-09-28: 155,790 above + the router's 795, measured by
   * `x build --target static` on `/posts/new` and `/settings`), against 157,184 (`153.5kb`).
   * why: the router's input fixes (22.8.1) — a click the view transition aimed at `<html>` is given
   * to the element under the pointer, a press skips the running transition, and a press or click
   * cancels the pending prefetch, so a fast click sends one request, not two (+795 B).
   *
   * raised 153.5kb → 156.5kb, measured 159,862 B (2026-10-05, plan 101 sweep 9, #505; summed the
   * way the 2026-09-22 line is, from `buildIslands` and `buildPageBoot`, because this route is not
   * prerendered and `x verify` weighs no value of `:id`) — the like control 41,738 + the header's
   * count 26,865 + the update banner 710 + the page boot 68,856 + the router and the `idle`
   * runtime 21,693, against 160,256. The same sum the same day before it: 181,414 (85,609 +
   * 36,115 + 710 + 37,287 + 21,693) — unenforced, it had grown past `153.5kb` unseen.
   * why: −21,552 B. The page runtime (the store, the socket host, the channel book) is in the page
   * boot, once, and neither island carries a copy: the like control lost 43,871 B, the count
   * 9,250. What both islands still each carry is solid-js and the error tables (#505 cut 2).
   *
   * raised 156.5kb → 173kb, measured 177,027 B (2026-11-05, plan 101 wave 5a; the same sum, because
   * the static report still lists `:id` `weighable: false`) — the like control 41,477 + the count
   * 23,488 + the banner 710 + the page boot 79,905 + the router 29,218 + the inline runtime 2,229,
   * against 177,152. why: the same sum on main is 171,914, already 11,658 B past `156.5kb` and
   * unenforced, as this budget has been since it was written: the page boot 68,856 → 78,468, the
   * router's growth, across plan 101's waves. This wave's +5,113 B: the like control +2,267, nearly
   * all `pollEvery`'s timer, the once-a-minute repair read behind an at-most-once channel; the page
   * boot +1,437, a pinned read's URL and the session flag; the router +1,409, `refresh()` keeping
   * the same visitor's focus.
   *
   * raised 173kb → 209.5kb, measured 214,059 B (2026-11-06, plan 101 slice 41; the same sum, from
   * `buildIslands` and `x verify --only budgets`' charges on the routes it weighs) — the like
   * control 44,182 + the count 23,574 + the summary 30,272 + the banner 710 + the page boot 82,123
   * + the router 29,570 + `/x-client-vitals.js` 1,202 + the inline runtime 2,426.
   * why: +30,272 B is the summary island: `summarize` read token by token through the typed
   * client's `.stream()` — `rpc`, core's transport and `clientStream`, which no other island on
   * this page carried. The other +6,760 B is the page boot, the router and the vitals beacon
   * growing since 2026-11-05 on every `app/` route, not this island.
   */
  budget: { js: '209.5kb' },
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
    // Both instants arrive as the `Date`s the row type says: the read names them on the wire and
    // the query client revives them, nested comments included.
    return oneRow(await memberQueries.postById({ orgId: useActor().orgId, postId }), postId);
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
    <Layout banner={Banner} here={`/posts/${props.data.id}`}>
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

          {/*
            The body is markdown a member — or a model through `summarize` — wrote: parsed to a
            tree and rendered as elements, never as HTML, so a `<script>` in it is text. A server
            render, so all seven languages cost the page 0 B.
          */}
          <div class={styles.body}>
            <Markdown text={props.data.body} languages={allLanguages} />
          </div>

          {/*
            A draft's excerpt is what the feed and the blog show. When the body has moved on from
            it, the author sees exactly how — the stored excerpt against the one the body now
            gives (`excerptOf`, the `postExcerpts` backfill's own rule), signed and spoken.
          */}
          <Show
            when={
              props.data.status === 'draft' && props.data.excerpt !== excerptOf(props.data.body)
            }
          >
            <section class={styles.excerpt}>
              <Text tone="muted">{t('app.post.excerptStale')}</Text>
              <DiffView
                old={props.data.excerpt}
                new={excerptOf(props.data.body)}
                label={t('app.post.excerptDiff')}
              />
            </section>
          </Show>

          {/*
            The server's half: a button that cannot stream without scripting (disabled until the
            island mounts), the region the tokens land in, and the status line.
          */}
          <Summary
            postId={props.data.id}
            orgId={props.data.orgId}
            writingLabel={t('app.post.summaryWriting')}
            failedLabel={t('app.post.summaryFailed')}
          >
            <Button type="button" disabled>
              {t('app.post.summarize')}
            </Button>
            <p data-role="summary" aria-live="polite" />
            <Text tone="muted">
              <span data-role="status" />
            </Text>
          </Summary>

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
              <form
                method="post"
                action={actionHttpPath(PUBLISH_ACTION, { postId: props.data.id }).path}
              >
                <input type="hidden" name="postId" value={props.data.id} />
                <input type="hidden" name="orgId" value={props.data.orgId} />
                <Button type="submit">{t('app.post.publish')}</Button>
              </form>
            </Show>
            <Show when={props.data.status === 'published' && canPublish}>
              <ConfirmDialog
                action={WITHDRAW_ENDPOINT}
                trigger={t('app.post.withdraw')}
                title={t('app.post.withdrawTitle')}
                consequence={t('app.post.withdrawConsequence')}
                confirmLabel={t('app.post.withdrawConfirm')}
              >
                <input type="hidden" name="postId" value={props.data.id} />
                <input type="hidden" name="orgId" value={props.data.orgId} />
              </ConfirmDialog>
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
          {/* The comments are an activity feed: `Timeline` + `RelativeTime`, no component of their own. */}
          <Timeline
            label={t('app.post.commentsHeading')}
            items={props.data.comments.map((comment, index) => ({
              key: comment.id,
              // An `ordinal` family: "2nd comment", "2.º comentario" — CLDR's rules per locale.
              title: (
                <Text tone="muted">{t('app.post.commentNumber', { ordinal: index + 1 })}</Text>
              ),
              detail: <Text>{comment.body}</Text>,
              when: <RelativeTime value={comment.createdAt} timeZone={viewer.zone} />,
            }))}
          />
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
