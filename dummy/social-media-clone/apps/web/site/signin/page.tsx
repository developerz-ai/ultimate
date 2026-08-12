// Sign in. On `site/` because it is the one page a signed-out visitor must be able to reach, and
// because it needs no JavaScript: a native `<form method="post">` at the route `createSession`
// already derives. Nothing here hydrates, so the browser's own form handling IS the client.

import { NEXT_PARAM, nextAfterSignIn } from '@ultimat3/http';
import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import {
  CAPTCHA_AFTER_FAILURES,
  captchaSiteKey,
  HCAPTCHA_SCRIPT_URL,
} from '../../shared/auth-policy';
import { ActionButton } from '../../shared/ui/action';
import { AppShell } from '../../shared/ui/app-shell';
import { Field } from '../../shared/ui/field';
import styles from './page.module.scss';

export const config = defineRoute({
  // `ssr`, not `static`: whether the anti-bot widget exists at all is read from the environment,
  // and a prerendered copy would freeze one deployment's answer into the artifact.
  render: 'ssr',
  hydrate: 'never',
  // Never from a cache. A stale sign-in form is a form posting at a build that has moved on.
  offline: 'network-only',
  budget: { js: '0kb', lcp: 1500 },
  meta: () => ({
    title: t('site.signin.title'),
    description: t('site.signin.description'),
    // Not a search result, and indexing it invites a crawler at the form. `RobotsDirectives` is
    // an object, not the `noindex` string a `<meta>` ends up carrying — the string is rendered.
    robots: { index: false, follow: false },
  }),
});

export interface SignInProps {
  readonly query: Readonly<Record<string, string>>;
  readonly url?: string | undefined;
}

export function Page(props: SignInProps) {
  const siteKey = captchaSiteKey();
  // Where the pipeline said this visitor was going before it bounced them here. `nextAfterSignIn`
  // refuses anything that is not a same-origin path — `?next=` is off the URL bar, and an
  // unchecked value makes the one page that hands out a session an open redirect.
  const next = nextAfterSignIn(props.query[NEXT_PARAM], '/dashboard');

  return (
    <AppShell url={props.url}>
      <div class={styles.auth}>
        <div class={styles.head}>
          <h1 class={styles.title}>{t('site.signin.title')}</h1>
          <p class={styles.lede}>{t('site.signin.description')}</p>
        </div>

        {/* The action is the route `createSession` derives, not a path anyone chose twice. */}
        <form class={styles.card} method="post" action="/api/sessions/create">
          {/* The return trip. A native form carries it as a field because nothing here hydrates. */}
          <input type="hidden" name={NEXT_PARAM} value={next} />

          <Field
            id="signin-handle"
            name="handle"
            label={t('site.signin.handle')}
            autocomplete="username"
            required
            maxlength={30}
          />
          <Field
            id="signin-password"
            name="password"
            label={t('site.signin.password')}
            type="password"
            autocomplete="current-password"
            required
          />

          {siteKey === null ? (
            <p class={styles.note}>{t('site.signin.captchaOff')}</p>
          ) : (
            <>
              <p class={styles.note}>
                {t('site.signin.captchaAfterFailures', { count: CAPTCHA_AFTER_FAILURES })}
              </p>
              {/* Rendered on every load rather than only after a failure: the page cannot know how
                  many times THIS handle has been refused before the handle is typed, and the server
                  is the only thing that decides whether the answer is demanded. */}
              <div class="h-captcha" data-sitekey={siteKey} />
              <script src={HCAPTCHA_SCRIPT_URL} async defer />
            </>
          )}

          <ActionButton size="lg">{t('site.signin.submit')}</ActionButton>
        </form>

        <section class={styles.demo}>
          <h2 class={styles.demoTitle}>{t('site.signin.demo.title')}</h2>
          <ul class={styles.demoList}>
            <li>{t('site.signin.demo.user')}</li>
            <li>{t('site.signin.demo.admin')}</li>
          </ul>
        </section>

        <p class={styles.alt}>
          {t('site.signin.noAccount')} <a href="/signup">{t('site.signin.createOne')}</a>
        </p>

        {/* `<details>` is the only disclosure a 0kb page can have, and this is the right thing to
            put behind one: signing out is not what anyone came to this page to do. */}
        <details class={styles.signOut}>
          <summary class={styles.summary}>{t('site.signin.signOut.title')}</summary>
          <p class={styles.note}>{t('site.signin.signOut.description')}</p>
          <form method="post" action="/api/sessions/destroy">
            {/* A form with no fields posts an empty body, and an action's input is an object. */}
            <input type="hidden" name="confirm" value="sign-out" />
            <ActionButton variant="secondary">{t('site.signin.signOut.submit')}</ActionButton>
          </form>
        </details>
      </div>
    </AppShell>
  );
}
