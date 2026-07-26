// UiProvider — the single place an app injects presentation context. Reactive
// access goes through the Solid adapter, so this file imports only solid types.

import { directionOf, type Locale, type Translator } from '@ultimat3/i18n';
import type { TimeZone } from '@ultimat3/time';
import type { JSX } from 'solid-js';
import type { Theme } from '../tokens/tokens';
import {
  fallbackTranslator,
  UI_DEFAULT_CURRENCY,
  UI_DEFAULT_LOCALE,
  UI_DEFAULT_TIME_ZONE,
  type UiContextValue,
  uiContext,
} from './context';
import { solid } from './solid-adapter';

export interface UiProviderProps {
  theme?: Theme | undefined;
  locale?: Locale | undefined;
  timeZone?: TimeZone | undefined;
  currency?: string | undefined;
  t?: Translator | undefined;
  children?: JSX.Element | undefined;
}

/**
 * Also reflects `lang` and `dir` onto <html>, so the document, native form
 * controls, and every logical property agree with the injected locale.
 */
export function UiProvider(props: UiProviderProps): JSX.Element {
  const rt = solid();
  const value = rt.createMemo<UiContextValue>(() => {
    const locale = props.locale ?? UI_DEFAULT_LOCALE;
    return {
      theme: props.theme ?? 'light',
      locale,
      timeZone: props.timeZone ?? UI_DEFAULT_TIME_ZONE,
      currency: props.currency ?? UI_DEFAULT_CURRENCY,
      dir: directionOf(locale),
      t: props.t ?? fallbackTranslator(locale),
    };
  });

  rt.createEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const next = value();
    root.setAttribute('lang', next.locale);
    root.setAttribute('dir', next.dir);
    if (props.theme !== undefined) root.setAttribute('data-theme', next.theme);
  });

  const Ctx = uiContext();
  return <Ctx.Provider value={value()}>{props.children}</Ctx.Provider>;
}
