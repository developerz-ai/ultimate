// The admin shell: skip link, sidebar (brand, who is acting, search, permission-filtered nav, the
// way back to the app), main region. Landmarks and a visible focus order are the accessibility
// contract; the theme attributes come from the token system, so nothing here knows a colour.
// Every control is a link or a native form — the shell ships no script.

// why: `*.module.scss` is typed by ONE ambient declaration, and it is `@ultimat3/ui`'s. A copy
// here would be a `.d.ts` in `src/`, which the package-shape gate reads as a build artifact.
/// <reference path="../../ui/src/scss.d.ts" />

import { t } from '@ultimat3/i18n';
import { Input } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import type { AdminApp } from './admin';
import styles from './admin.module.scss';
import type { AdminActor } from './authz';
import type { NavGroup } from './nav';

export interface AdminLayoutProps {
  readonly app: AdminApp;
  /** Already filtered by `app.navFor(ctx)`. The layout does not decide visibility. */
  readonly nav: readonly NavGroup[];
  readonly currentPath: string;
  /** Who is acting. Absent or anonymous reads as "not signed in" — never as an empty line. */
  readonly actor?: AdminActor | null;
  /** The screen's heading, already translated. One `<h1>` per screen, and this is it. */
  readonly title?: string;
  readonly children: JSX.Element;
}

/** The one rendering of "who am I acting as", so no two screens can disagree about it. */
export const actorLabel = (actor: AdminActor | null | undefined): string =>
  actor === null || actor === undefined || actor.id === 'anonymous'
    ? t('admin.actor.anonymous')
    : t('admin.actor.signedIn', { id: actor.id, roles: (actor.roles ?? []).join(', ') });

export function AdminLayout(props: AdminLayoutProps): JSX.Element {
  const theme = props.app.theme;
  const base = props.app.basePath;
  return (
    <div
      class={styles['shell']}
      data-admin=""
      data-theme={theme['data-theme']}
      data-density={theme['data-density']}
      style={theme.style}
    >
      <aside class={styles['side']}>
        <a class={styles['skip']} href="#x-admin-main">
          {t('admin.a11y.skip-to-content')}
        </a>

        <a class={styles['brand']} href={base}>
          {props.app.branding.logo === undefined ? null : (
            <img
              src={props.app.branding.logo.src}
              alt={t(props.app.branding.logo.altKey)}
              width={props.app.branding.logo.width ?? 24}
            />
          )}
          <span>{t(props.app.branding.nameKey)}</span>
        </a>
        <p class={styles['actor']}>{actorLabel(props.actor)}</p>

        {/* A native GET at the search route: the term rides the URL, so a result page is a link
            an operator can send and the form needs no handler. */}
        <search class={styles['search']}>
          <form method="get" action={`${base}/search`}>
            <label class={styles['hidden']} for="x-admin-search-input">
              {t('admin.search.label')}
            </label>
            <Input
              id="x-admin-search-input"
              name="term"
              type="search"
              placeholder={t('admin.search.placeholder')}
            />
          </form>
        </search>

        <nav class={styles['group']} aria-label={t('admin.nav.label')}>
          {props.nav.map((group) => (
            <section class={styles['group']}>
              <h2 class={styles['groupTitle']}>{t(group.labelKey)}</h2>
              <ul class={styles['navList']}>
                {group.items.map((item) => (
                  <li>
                    <a
                      class={styles['navLink']}
                      href={`${base}${item.href}`}
                      aria-current={
                        props.currentPath === `${base}${item.href}` ? 'page' : undefined
                      }
                    >
                      {t(item.labelKey)}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>

        {/* The way out. The admin's route table never points back at the app, so without this an
            operator who opened the dashboard has no link home and edits the URL bar. */}
        <a class={styles['navLink']} href="/">
          {t('admin.backToApp')}
        </a>
      </aside>

      <main id="x-admin-main" class={styles['main']} tabindex={-1}>
        {props.title === undefined ? null : <h1 class={styles['title']}>{props.title}</h1>}
        {props.children}
      </main>
    </div>
  );
}
