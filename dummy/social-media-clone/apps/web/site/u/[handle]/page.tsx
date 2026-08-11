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
import { Avatar, Card, PageHeader, Section, Stack, Text } from '@ultimat3/ui';
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

export async function Page(props: { readonly params?: Readonly<Record<string, string>> }) {
  const handle = handleOf(props.params ?? {});
  // A null viewer: anonymous. Every hiding decision below follows from that one argument.
  const profile = await publicProfile(null, handle);

  if (profile === null) {
    return (
      <main class={styles.profile}>
        <PageHeader
          title={t('site.profile.notFound.title')}
          description={t('site.profile.notFound.description')}
        />
      </main>
    );
  }

  const { user, posts } = profile;

  return (
    <main class={styles.profile}>
      <PageHeader
        title={user.displayName}
        description={user.bio ?? undefined}
        media={<Avatar name={user.displayName} size="xl" />}
      />
      <Text as="p" tone="muted" class={styles.identity}>
        @{user.handle} · {t('site.profile.joined', { date: day(user.createdAt) })}
      </Text>

      <Section title={t('site.profile.posts.title')}>
        {posts.length === 0 ? (
          <Text as="p" tone="muted">
            {t('site.profile.posts.empty')}
          </Text>
        ) : (
          <Stack as="ul" gap={4} class={styles.list}>
            {posts.map((post) => (
              <Card as="li" padding={4}>
                <article>
                  <time datetime={post.publishedAt.toISOString()} class={styles.when}>
                    {day(post.publishedAt)}
                  </time>
                  <p class={styles.body}>{post.body}</p>
                  <footer class={styles.counts}>
                    <span>{t('site.feed.likes', { count: post.likeCount })}</span>
                    <span>{t('site.feed.comments', { count: post.commentCount })}</span>
                  </footer>
                </article>
              </Card>
            ))}
          </Stack>
        )}
      </Section>
    </main>
  );
}
