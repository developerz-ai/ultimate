// The one header every page wears: wordmark, primary navigation, and the session control.
//
// Two headers would be two answers to "where am I and who am I", so the signed-out and signed-in
// variants differ only by what `navFor` returns and which control sits at the end. Nothing here
// hydrates — `site/` ships 0kb of JS — so the session control is a native form and the narrow
// layout is a scroll strip rather than a menu that would need a script to open.

import { t } from '@ultimat3/i18n';
import { Icon } from '@ultimat3/ui';
import { iconAtSign } from '@ultimat3/ui/icons/at-sign';
import { iconLogIn } from '@ultimat3/ui/icons/log-in';
import { iconLogOut } from '@ultimat3/ui/icons/log-out';
import type { JSX } from 'solid-js';
import { isCurrent, navFor } from './nav';
import styles from './site-header.module.scss';

export interface SiteHeaderProps {
  /** Path of the page being rendered. Only this decides which item carries `aria-current`. */
  readonly pathname: string;
  readonly signedIn: boolean;
}

export function SiteHeader(props: SiteHeaderProps): JSX.Element {
  return (
    <header class={styles.header}>
      <div class={styles.bar}>
        <a class={styles.brand} href="/">
          <span class={styles.mark} aria-hidden="true">
            <Icon glyph={iconAtSign} />
          </span>
          <span class={styles.wordmark}>{t('brand.name')}</span>
        </a>

        <nav class={styles.nav} aria-label={t('nav.primary')}>
          <ul class={styles.list}>
            {navFor(props.signedIn).map((item) => (
              <li>
                <a
                  class={styles.link}
                  href={item.href}
                  // The attribute, not a class: "this is the page you are on" is a fact a screen
                  // reader announces, and the highlight is styled from the same fact.
                  aria-current={isCurrent(item.href, props.pathname) ? 'page' : undefined}
                >
                  <Icon glyph={item.glyph} />
                  <span>{t(`nav.${item.name}`)}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div class={styles.actions}>{props.signedIn ? <SignOutControl /> : <SignInControl />}</div>
      </div>
    </header>
  );
}

/** A native POST at the action's own HTTP projection — the same path the sign-in page posts to. */
function SignOutControl(): JSX.Element {
  return (
    <form class={styles.session} method="post" action="/api/sessions/destroy">
      {/* A form with no fields posts an empty body, and an action's input is an object. */}
      <input type="hidden" name="confirm" value="sign-out" />
      <button class={styles.ghost} type="submit">
        <Icon glyph={iconLogOut} />
        <span>{t('nav.signOut')}</span>
      </button>
    </form>
  );
}

function SignInControl(): JSX.Element {
  return (
    <>
      <a class={styles.ghost} href="/signin">
        <Icon glyph={iconLogIn} />
        <span>{t('nav.signIn')}</span>
      </a>
      <a class={styles.cta} href="/signup">
        {t('nav.signUp')}
      </a>
    </>
  );
}
