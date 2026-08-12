// The public profile at `/u/:handle`. The directory IS the URL — `[handle]` becomes `:handle` and
// `page.tsx` names the kind of file, never a segment.
//
// On `site/` because it is readable without a session, and that is a POLICY decision written down:
// the viewer passed to `publicProfile` is `null`, so `canSeePost` decides with an anonymous actor
// and a friends-only post never reaches this page. 0kb of JS, `hydrate: 'never'`, SSR because the
// content is per-request.
//
// `meta` loads the profile a second time. There is no `load` seam on a route, so the head and the
// body have no shared data — the two reads run concurrently (`Promise.all` in the renderer) and
// this is the cost of that gap, recorded rather than hidden.

import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import { Icon } from '@ultimat3/ui';
import { iconArrowRight } from '@ultimat3/ui/icons/arrow-right';
import { iconUserSearch } from '@ultimat3/ui/icons/user-search';
import { ActionLink } from '../../../shared/ui/action';
import { AppShell } from '../../../shared/ui/app-shell';
import { EmptyState } from '../../../shared/ui/empty-state';
import { PageHeading } from '../../../shared/ui/page-heading';
import { PostCard } from '../../../shared/ui/post-card';
import { publicProfile } from '../service';
import styles from './page.module.scss';

interface ProfileData extends Record<string, unknown> {
  readonly url: string;
  readonly params: Readonly<Record<string, string>>;
}

/** `noUncheckedIndexedAccess` is on: a param is `string | undefined` until something says otherwise. */
const handleOf = (params: Readonly<Record<string, string>>): string => params.handle ?? '';

export const config = defineRoute<ProfileData>({
  render: 'ssr',
  hydrate: 'never',
  offline: 'runtime',
  budget: { js: '0kb', lcp: 2000 },
  meta: async (data) => {
    const profile = await publicProfile(null, handleOf(data.params));
    if (profile === null) {
      return {
        title: t('site.profile.notFound.title'),
        description: t('site.profile.notFound.description'),
        robots: { index: false, follow: false },
      };
    }
    const vars = { name: profile.user.displayName, handle: profile.user.handle };
    return {
      title: t('site.profile.title', vars),
      description: profile.user.bio ?? t('site.profile.description', vars),
      canonical: `/u/${profile.user.handle}`,
    };
  },
});

/** Formatted with an explicit zone. There is no ambient default, anywhere, on purpose. */
const day = (value: Date): string =>
  new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(value);

/** First character of the display name. Decorative — the name is rendered right beside it. */
const initialOf = (name: string): string => (name.at(0) ?? '').toUpperCase();

export async function Page(props: {
  readonly params?: Readonly<Record<string, string>>;
  readonly url?: string | undefined;
}) {
  const handle = handleOf(props.params ?? {});
  // A null viewer: anonymous. Every hiding decision below follows from that one argument.
  const profile = await publicProfile(null, handle);

  if (profile === null) {
    return (
      <AppShell url={props.url}>
        <PageHeading
          title={t('site.profile.notFound.title')}
          lede={t('site.profile.notFound.description')}
        />
        {/* A dead end needs a door. The feed is the one page every visitor may open. */}
        <ActionLink href="/feed" size="lg">
          {t('site.profile.notFound.cta')}
          <Icon glyph={iconArrowRight} />
        </ActionLink>
      </AppShell>
    );
  }

  const { user, posts } = profile;

  return (
    <AppShell url={props.url}>
      <header class={styles.identity}>
        <span class={styles.avatar} aria-hidden="true">
          {initialOf(user.displayName)}
        </span>
        <div class={styles.who}>
          <h1 class={styles.name}>{user.displayName}</h1>
          <p class={styles.handle}>@{user.handle}</p>
          {user.bio === null ? null : <p class={styles.bio}>{user.bio}</p>}
          <p class={styles.joined}>{t('site.profile.joined', { date: day(user.createdAt) })}</p>
        </div>
      </header>

      <h2 class={styles.section}>{t('site.profile.posts.title')}</h2>

      {posts.length === 0 ? (
        <EmptyState
          glyph={iconUserSearch}
          title={t('site.profile.posts.empty')}
          description={t('site.profile.posts.emptyHelp')}
        />
      ) : (
        <ul class={styles.list}>
          {posts.map((post) => (
            <li>
              <PostCard
                body={post.body}
                publishedAt={post.publishedAt}
                published={day(post.publishedAt)}
                likeCount={post.likeCount}
                commentCount={post.commentCount}
              />
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}
