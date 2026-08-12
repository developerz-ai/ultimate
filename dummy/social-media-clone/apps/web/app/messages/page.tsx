// The conversation list. `ssr` and not `stream`: `render: 'stream'` needs a `<Suspense>` boundary
// to stream into, and the pinned solid-js@2.0.0-experimental.16 exports none from its server build
// (docs/gotchas.md). `hydrate: 'never'` and a 0kb budget say the same thing out loud — there is no
// DOM renderer in this dependency set, so no page here ships client JS.
//
// The component is `async` because a route has no `load` seam: RouteDefinition carries render,
// offline, hydrate, budget, meta and policy, and nothing that fetches. The renderer awaits a
// promise, so an async component works — recorded, not hidden.

import { actorOf } from '@ultimat3/action';
import { useContext } from '@ultimat3/core';
import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import { iconMessageSquare } from '@ultimat3/ui/icons/message-square';
import { AppShell } from '../../shared/ui/app-shell';
import { EmptyState } from '../../shared/ui/empty-state';
import { PageHeading } from '../../shared/ui/page-heading';
import styles from './page.module.scss';
import { type ThreadSummary, threadsFor } from './service';

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'never',
  offline: 'runtime',
  // Auth is a policy, never a route-local flag. The route-level check answers "may this actor read
  // messages at all"; WHICH threads is decided per row by `threadRead`, which the thread page and
  // the send action evaluate against the participants row.
  policy: { permission: 'message:read' },
  budget: { js: '0kb', lcp: 2000 },
  // An authed screen is never indexable: the crawler that fetched it would be signed in as
  // somebody, and a thread list has no public URL to rank.
  meta: () => ({
    title: t('app.messages.title'),
    description: t('app.messages.description'),
    robots: { index: false },
  }),
});

export async function Page(props: { readonly url?: string | undefined }) {
  const ctx = useContext();
  // The framework's own identity, not `currentViewer()`: membership is a row keyed by user id, so
  // the resolved friend/block graph a post rule needs is not part of this question.
  const viewer = actorOf(ctx);
  const threads = viewer === null ? [] : await threadsFor(viewer.id);

  return (
    <AppShell url={props.url}>
      <PageHeading title={t('app.messages.title')} lede={t('app.messages.description')} />

      {threads.length === 0 ? (
        // Honest rather than decorative: the demo seed creates no conversations yet, so this is
        // what the screen actually shows until it does.
        <EmptyState
          glyph={iconMessageSquare}
          title={t('app.messages.empty')}
          description={t('app.messages.emptyHelp')}
        />
      ) : (
        <ul class={styles.list}>
          {threads.map((thread) => (
            <li>
              <a class={styles.thread} href={`/messages/${thread.conversationId}`}>
                <span class={styles.head}>
                  <span class={styles.name}>{nameOf(thread)}</span>
                  {thread.latest === null ? null : (
                    <time class={styles.when} datetime={thread.latest.createdAt.toISOString()}>
                      {stamp(thread.latest.createdAt, ctx.tz)}
                    </time>
                  )}
                </span>
                <span class={styles.preview}>
                  {thread.latest?.body ?? t('app.messages.noMessages')}
                </span>
                {thread.unread ? (
                  <span class={styles.unread}>{t('app.messages.unread')}</span>
                ) : null}
              </a>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}

/** A group is its title; a direct thread is whoever else is in it. Never a bare id in the UI. */
const nameOf = (thread: ThreadSummary): string =>
  thread.title ??
  (thread.otherNames.length === 0
    ? t('app.messages.nobodyElse')
    : t('app.messages.directWith', { names: thread.otherNames.join(', ') }));

/** Formatted with the request's zone, passed explicitly. There is no ambient default, anywhere. */
const stamp = (value: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
    value,
  );
