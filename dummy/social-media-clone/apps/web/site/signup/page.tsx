// Create an account. Same shape as sign-in and for the same reasons: `site/`, no JavaScript, a
// native form posting at the route `createAccount` derives. The only difference is that the
// challenge here is demanded on EVERY attempt — there is no prior failure to count.

import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import { captchaSiteKey, HCAPTCHA_SCRIPT_URL, MIN_PASSWORD_LENGTH } from '../../shared/auth-policy';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'never',
  offline: 'network-only',
  budget: { js: '0kb', lcp: 1500 },
  meta: () => ({
    title: t('site.signup.title'),
    description: t('site.signup.description'),
    // Not a search result, and indexing it invites a crawler at the form. `RobotsDirectives` is
    // an object, not the `noindex` string a `<meta>` ends up carrying — the string is rendered.
    robots: { index: false, follow: false },
  }),
});

export function Page() {
  const siteKey = captchaSiteKey();

  return (
    <main class={styles.auth}>
      <h1>{t('site.signup.title')}</h1>
      <p class={styles.lede}>{t('site.signup.description')}</p>

      <form class={styles.form} method="post" action="/api/accounts/create">
        <label class={styles.label} for="signup-handle">
          {t('site.signup.handle')}
        </label>
        <input
          id="signup-handle"
          name="handle"
          type="text"
          autocomplete="username"
          required
          maxlength={30}
          pattern="[A-Za-z0-9_]+"
        />
        <p class={styles.note}>{t('site.signup.handleHint')}</p>

        <label class={styles.label} for="signup-name">
          {t('site.signup.displayName')}
        </label>
        <input
          id="signup-name"
          name="displayName"
          type="text"
          autocomplete="name"
          required
          maxlength={80}
        />

        <label class={styles.label} for="signup-email">
          {t('site.signup.email')}
        </label>
        <input id="signup-email" name="email" type="email" autocomplete="email" required />

        <label class={styles.label} for="signup-password">
          {t('site.signup.password')}
        </label>
        <input
          id="signup-password"
          name="password"
          type="password"
          autocomplete="new-password"
          required
          minlength={MIN_PASSWORD_LENGTH}
        />
        <p class={styles.note}>{t('site.signup.passwordHint', { count: MIN_PASSWORD_LENGTH })}</p>

        {siteKey !== null && (
          <>
            <div class="h-captcha" data-sitekey={siteKey} />
            <script src={HCAPTCHA_SCRIPT_URL} async defer />
          </>
        )}

        <button class={styles.submit} type="submit">
          {t('site.signup.submit')}
        </button>
      </form>

      <p class={styles.note}>
        {t('site.signup.haveAccount')} <a href="/signin">{t('site.signup.signIn')}</a>
      </p>
    </main>
  );
}
