// One thread. The directory is the URL: `app/messages/[id]/page.tsx` -> `/messages/:id`.
//
// `ssr`, `hydrate: 'never'`, 0kb — same reason as the list: the pinned
// solid-js@2.0.0-experimental.16 publishes no DOM renderer, so `useLive` cannot run here and the
// rows are rendered once, on the server, from the same bounded read `liveThread` declares.
//
// The composer is a NATIVE form posting to the action's own HTTP projection. That is a real send
// path with no client JS — `@ultimat3/http` parses `application/x-www-form-urlencoded`
// (packages/http/src/request.ts:162) — and it is also where the missing client half shows: with
// nothing to intercept the response, the browser lands on the action's JSON instead of a
// re-rendered thread.

import { actorOf } from '@ultimat3/action';
import { useContext } from '@ultimat3/core';
import { t } from '@ultimat3/i18n';
import { defineRoute, type RouteParams } from '@ultimat3/render';
import { Icon } from '@ultimat3/ui';
import { iconArrowLeft } from '@ultimat3/ui/icons/arrow-left';
import { iconMessageSquare } from '@ultimat3/ui/icons/message-square';
import { ActionButton } from '../../../shared/ui/action';
import { AppShell } from '../../../shared/ui/app-shell';
import { EmptyState } from '../../../shared/ui/empty-state';
import { threadFor } from '../service';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'never',
  offline: 'runtime',
  policy: { permission: 'message:read' },
  budget: { js: '0kb', lcp: 2000 },
  meta: () => ({ title: t('app.messages.thread.title'), robots: { index: false } }),
});

export async function Page(props: {
  readonly params: RouteParams;
  readonly url?: string | undefined;
}) {
  const ctx = useContext();
  const viewer = actorOf(ctx);
  const conversationId = props.params.id ?? '';
  // Refuses before reading a single message, and refuses identically for a conversation that does
  // not exist. The rejection is never caught here: the framework renders an `UltimateError` with
  // its code, cause and fix, and a page that turned a denial into an empty list would be a page
  // that lies about authorization.
  const thread = await threadFor(viewer?.id ?? null, conversationId);

  return (
    <AppShell url={props.url}>
      <a class={styles.back} href="/messages">
        <Icon glyph={iconArrowLeft} />
        {t('app.messages.thread.back')}
      </a>
      <h1 class={styles.title}>{thread.title ?? t('app.messages.thread.title')}</h1>

      {thread.messages.length === 0 ? (
        <EmptyState
          glyph={iconMessageSquare}
          title={t('app.messages.thread.empty')}
          description={t('app.messages.thread.emptyHelp')}
        />
      ) : (
        <ul class={styles.list}>
          {thread.messages.map((message) => (
            <li class={message.authorId === viewer?.id ? styles.mine : styles.theirs}>
              <header class={styles.byline}>
                <span class={styles.who}>
                  {message.authorId === viewer?.id
                    ? t('app.messages.you')
                    : (thread.namesById.get(message.authorId) ?? t('app.messages.them'))}
                </span>
                <time datetime={message.createdAt.toISOString()}>
                  {stamp(message.createdAt, ctx.tz)}
                </time>
              </header>
              <p class={styles.body}>{message.body}</p>
            </li>
          ))}
        </ul>
      )}

      <form class={styles.compose} method="post" action="/api/messages/send">
        <input type="hidden" name="conversationId" value={conversationId} />
        <label class={styles.label} for="message-body">
          {t('app.messages.compose.label')}
        </label>
        <textarea
          class={styles.field}
          id="message-body"
          name="body"
          rows={3}
          placeholder={t('app.messages.compose.placeholder')}
        />
        <ActionButton>{t('app.messages.compose.send')}</ActionButton>
      </form>
    </AppShell>
  );
}

/** Formatted with the request's zone, passed explicitly. There is no ambient default, anywhere. */
const stamp = (value: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
    value,
  );
