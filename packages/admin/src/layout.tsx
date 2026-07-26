// The admin shell: skip link, header, permission-filtered nav, main region. Landmarks and a
// visible focus order are the accessibility contract; the theme attributes come from the
// token system, so nothing here knows a colour.

import { type Locale, registeredLocales, t } from '@ultimat3/i18n';
import { LocaleSwitcher, ThemeToggle } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import type { AdminApp } from './admin';
import type { NavGroup } from './nav';

export interface AdminLayoutProps {
  readonly app: AdminApp;
  /** Already filtered by `app.navFor(ctx)`. The layout does not decide visibility. */
  readonly nav: readonly NavGroup[];
  readonly currentPath: string;
  readonly onSearch?: (term: string) => void;
  readonly onLocaleChange?: (locale: Locale) => void;
  readonly children: JSX.Element;
}

export function AdminLayout(props: AdminLayoutProps): JSX.Element {
  const theme = props.app.theme;
  return (
    <div
      class="x-admin"
      data-theme={theme['data-theme']}
      data-density={theme['data-density']}
      style={theme.style}
    >
      <a class="x-admin-skip" href="#x-admin-main">
        {t('admin.a11y.skip-to-content')}
      </a>

      <header class="x-admin-header">
        <a class="x-admin-brand" href={props.app.basePath}>
          {props.app.branding.logo === undefined ? null : (
            <img
              src={props.app.branding.logo.src}
              alt={t(props.app.branding.logo.altKey)}
              width={props.app.branding.logo.width ?? 24}
            />
          )}
          <span>{t(props.app.branding.nameKey)}</span>
        </a>

        <search class="x-admin-search">
          <form
            onSubmit={(event: SubmitEvent) => {
              event.preventDefault();
              const field = (event.currentTarget as HTMLFormElement).elements.namedItem('term');
              props.onSearch?.(field instanceof HTMLInputElement ? field.value : '');
            }}
          >
            <label class="x-admin-visually-hidden" for="x-admin-search-input">
              {t('admin.search.label')}
            </label>
            <input
              id="x-admin-search-input"
              name="term"
              type="search"
              placeholder={t('admin.search.placeholder')}
            />
          </form>
        </search>

        <div class="x-admin-header-tools">
          {/* The locales with a catalog: an option nobody translated is a broken page. */}
          <LocaleSwitcher locales={registeredLocales()} onLocaleChange={props.onLocaleChange} />
          <ThemeToggle />
        </div>
      </header>

      <div class="x-admin-body">
        <nav class="x-admin-nav" aria-label={t('admin.nav.label')}>
          {props.nav.map((group) => (
            <section>
              <h2>{t(group.labelKey)}</h2>
              <ul>
                {group.items.map((item) => (
                  <li>
                    <a
                      href={`${props.app.basePath}${item.href}`}
                      aria-current={
                        props.currentPath === `${props.app.basePath}${item.href}`
                          ? 'page'
                          : undefined
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

        <main id="x-admin-main" class="x-admin-main" tabindex={-1}>
          {props.children}
        </main>
      </div>
    </div>
  );
}
