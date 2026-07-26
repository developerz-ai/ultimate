// Theme control. `toggle` flips light/dark; `select` also offers "system", which
// clears the stored choice so the OS takes over again. All strings come from the
// catalog, and the DOM work happens in theme.ts, never here.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import {
  browserThemeEnv,
  clearTheme,
  resolveTheme,
  setTheme,
  storedTheme,
  type Theme,
  type ThemeEnv,
  toggleTheme,
  watchOsTheme,
} from '../theme/theme';
import { IconButton } from './IconButton';
import { Select } from './Select';
import styles from './ThemeToggle.module.scss';

export type ThemeChoice = Theme | 'system';

export interface ThemeToggleProps {
  mode?: 'toggle' | 'select' | undefined;
  /** Server-render value; the effect corrects it on the client before paint. */
  initial?: Theme | undefined;
  /** Injectable for tests and for non-DOM hosts. */
  env?: ThemeEnv | undefined;
  class?: string | undefined;
}

export function ThemeToggle(props: ThemeToggleProps): JSX.Element {
  const ui = useUi();
  const rt = solid();
  const [choice, setChoice] = rt.createSignal<ThemeChoice>(props.initial ?? 'system');
  const [resolved, setResolved] = rt.createSignal<Theme>(props.initial ?? 'light');

  const env = (): ThemeEnv => props.env ?? browserThemeEnv();

  const sync = (): void => {
    const current = env();
    setChoice(storedTheme(current) ?? 'system');
    setResolved(resolveTheme(current));
  };

  rt.createEffect(() => {
    if (props.env === undefined && typeof window === 'undefined') return;
    sync();
    const stop = watchOsTheme(env());
    rt.onCleanup(stop);
  });

  const apply = (next: ThemeChoice): void => {
    if (next === 'system') clearTheme(env());
    else setTheme(next, env());
    sync();
  };

  if (props.mode === 'select') {
    return (
      <Select
        class={cx(styles['select'], props.class)}
        aria-label={ui.t(UI_KEYS.theme)}
        value={choice()}
        options={[
          { value: 'system', label: ui.t(UI_KEYS.themeSystem) },
          { value: 'light', label: ui.t(UI_KEYS.themeLight) },
          { value: 'dark', label: ui.t(UI_KEYS.themeDark) },
        ]}
        onChange={(event) => apply(event.currentTarget.value as ThemeChoice)}
      />
    );
  }

  return (
    <IconButton
      class={cx(styles['toggle'], props.class)}
      label={resolved() === 'dark' ? ui.t(UI_KEYS.themeLight) : ui.t(UI_KEYS.themeDark)}
      aria-pressed={resolved() === 'dark'}
      round
      onClick={() => {
        toggleTheme(env());
        sync();
      }}
    >
      <span class={styles['glyph']} data-theme-glyph={resolved()} />
    </IconButton>
  );
}
