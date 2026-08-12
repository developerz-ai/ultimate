// Create an account. Same shape as sign-in and for the same reasons: `site/`, no JavaScript, a
// native form posting at the route `createAccount` derives. The only difference is that the
// challenge here is demanded on EVERY attempt — there is no prior failure to count.

import { NEXT_PARAM, nextAfterSignIn } from '@ultimat3/http';
import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import { captchaSiteKey, HCAPTCHA_SCRIPT_URL, MIN_PASSWORD_LENGTH } from '../../shared/auth-policy';
import { ActionButton } from '../../shared/ui/action';
import { AppShell } from '../../shared/ui/app-shell';
import { Field } from '../../shared/ui/field';
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

export interface SignUpProps {
  readonly query: Readonly<Record<string, string>>;
  readonly url?: string | undefined;
}

export function Page(props: SignUpProps) {
  // Same round trip the sign-in page carries: somebody bounced off a guarded page may create the
  // account instead of signing in, and must still land where they were going.
  const next = nextAfterSignIn(props.query[NEXT_PARAM], '/dashboard');
  const siteKey = captchaSiteKey();

  return (
    <AppShell url={props.url}>
      <div class={styles.auth}>
        <div class={styles.head}>
          <h1 class={styles.title}>{t('site.signup.title')}</h1>
          <p class={styles.lede}>{t('site.signup.description')}</p>
        </div>

        <form class={styles.card} method="post" action="/api/accounts/create">
          <input type="hidden" name={NEXT_PARAM} value={next} />

          <Field
            id="signup-handle"
            name="handle"
            label={t('site.signup.handle')}
            autocomplete="username"
            required
            maxlength={30}
            pattern="[A-Za-z0-9_]+"
            hint={t('site.signup.handleHint')}
          />
          <Field
            id="signup-name"
            name="displayName"
            label={t('site.signup.displayName')}
            autocomplete="name"
            required
            maxlength={80}
          />
          <Field
            id="signup-email"
            name="email"
            label={t('site.signup.email')}
            type="email"
            autocomplete="email"
            required
          />
          <Field
            id="signup-password"
            name="password"
            label={t('site.signup.password')}
            type="password"
            autocomplete="new-password"
            required
            minlength={MIN_PASSWORD_LENGTH}
            hint={t('site.signup.passwordHint', { count: MIN_PASSWORD_LENGTH })}
          />

          {siteKey !== null && (
            <>
              <div class="h-captcha" data-sitekey={siteKey} />
              <script src={HCAPTCHA_SCRIPT_URL} async defer />
            </>
          )}

          <ActionButton size="lg">{t('site.signup.submit')}</ActionButton>
        </form>

        <p class={styles.alt}>
          {t('site.signup.haveAccount')} <a href="/signin">{t('site.signup.signIn')}</a>
        </p>
      </div>
    </AppShell>
  );
}
