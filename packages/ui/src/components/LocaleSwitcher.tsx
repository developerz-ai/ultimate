// Locale picker. Option labels come from `Intl.DisplayNames` in each locale's own
// language (endonyms), so the list needs no translation catalog of its own.

import type { Locale } from '@ultimat3/i18n';
import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import styles from './LocaleSwitcher.module.scss';
import { Select, type SelectOption } from './Select';

export interface LocaleSwitcherProps {
  locales: readonly Locale[];
  /** Defaults to the context locale. */
  value?: Locale | undefined;
  onLocaleChange?: ((locale: Locale) => void) | undefined;
  /** Render as links instead of a select, for a 0kb-JS `site/` route. */
  hrefFor?: ((locale: Locale) => string) | undefined;
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

  if (props.hrefFor !== undefined) {
    return (
      <nav class={cx(styles['links'], props.class)} aria-label={ui.t(UI_KEYS.language)}>
        {props.locales.map((tag) => (
          <a
            class={styles['link']}
            href={props.hrefFor?.(tag)}
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
