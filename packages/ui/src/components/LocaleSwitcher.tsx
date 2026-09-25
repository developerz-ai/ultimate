// Locale picker. Option labels come from `Intl.DisplayNames` in each locale's own
// language (endonyms), so the list needs no translation catalog of its own.

// Core's, never the i18n barrel's: that barrel installs the framework catalog at import, and this
// component ships in browser chunks (issue #490). `localizePath` is what i18n's `localizedPath` is.
import { localizePath } from '@ultimat3/core';
import type { Locale } from '@ultimat3/i18n';
import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import styles from './LocaleSwitcher.module.scss';
import { Select, type SelectOption } from './Select';

export interface LocaleSwitcherProps {
  /** Every locale to offer, the DEFAULT first — `routedLocales()` from `@ultimat3/i18n`. */
  locales: readonly Locale[];
  /** Defaults to the context locale. */
  value?: Locale | undefined;
  onLocaleChange?: ((locale: Locale) => void) | undefined;
  /**
   * Render as links instead of a select, for a 0kb-JS `site/` route. Defaults, when `path` is
   * given, to that page in each locale — `localizedPath`: unprefixed for the default, `/en/…`
   * otherwise — so a site's switcher needs no href of its own.
   */
  hrefFor?: ((locale: Locale) => string) | undefined;
  /** The page's own path, prefixed or not — `new URL(props.url).pathname`. Turns on links mode. */
  path?: string | undefined;
  /** The unprefixed locale. Defaults to `locales[0]`, which is where `routedLocales()` puts it. */
  defaultLocale?: Locale | undefined;
  class?: string | undefined;
}

/** Endonym: the language's name in its own language, e.g. `de` -> "Deutsch". */
export function localeLabel(tag: Locale): string {
  const names = new Intl.DisplayNames([tag], { type: 'language' });
  return names.of(tag) ?? tag;
}

export function LocaleSwitcher(props: LocaleSwitcherProps): JSX.Element {
  const ui = useUi();
  const current = (): Locale => props.value ?? ui.locale;
  const options = (): SelectOption[] =>
    props.locales.map((tag) => ({ value: tag, label: localeLabel(tag) }));

  const hrefFor = (): ((locale: Locale) => string) | undefined => {
    if (props.hrefFor !== undefined) return props.hrefFor;
    const path = props.path;
    if (path === undefined) return undefined;
    const fallback = props.defaultLocale ?? props.locales[0] ?? current();
    return (locale) => localizePath(path, locale, props.locales, fallback);
  };

  const linkFor = hrefFor();
  if (linkFor !== undefined) {
    return (
      <nav class={cx(styles['links'], props.class)} aria-label={ui.t(UI_KEYS.language)}>
        {props.locales.map((tag) => (
          <a
            class={styles['link']}
            href={linkFor(tag)}
            hreflang={tag}
            lang={tag}
            aria-current={tag === current() ? 'true' : undefined}
          >
            {localeLabel(tag)}
          </a>
        ))}
      </nav>
    );
  }

  return (
    <Select
      class={cx(styles['select'], props.class)}
      aria-label={ui.t(UI_KEYS.language)}
      value={current()}
      options={options()}
      onChange={(event) => props.onLocaleChange?.(event.currentTarget.value)}
    />
  );
}
