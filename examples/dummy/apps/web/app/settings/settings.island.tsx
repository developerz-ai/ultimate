/**
 * The preferences editor, in the browser: the one module on `/settings` a browser downloads.
 *
 * The page names this file by SPECIFIER and server-renders a summary of the SAVED preferences
 * inside the island's wrapper, so the screen paints before a byte of this module arrives; `mount`
 * replaces that shell with the editor, which is the part only a browser can do.
 *
 * An island MAY import a `.module.scss`. The island build runs `@ultimat3/render`'s own
 * `loadStylesheet` over every `.s?css` (`packages/cli/src/island-styles.ts`), so the default export
 * is the class map and not Bun's asset URL string, and the rules register into the same map a
 * document renders from — `buildIslands` runs before the first render. Class names agree with the
 * server by construction: the scope hash is over the file's BASENAME plus its source, never its
 * absolute path (`packages/render/src/css-modules.ts`).
 *
 * This one imports none anyway, which is a size decision and no longer a limit: `page.module.scss`
 * reaches this markup by tag, from the `.editor` wrapper the page renders around it.
 */

import type { CatalogSubset } from '@ultimat3/i18n/subset';
import { subsetTranslator } from '@ultimat3/i18n/subset';
import { subscribeToPush } from '@ultimat3/pwa/client';
import { mountOver } from '@ultimat3/render/client';
import type { SearchableOption } from '@ultimat3/ui';
import { Radio, SearchableSelect, setSolidRuntime, UiProvider } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import {
  createContext,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  onCleanup,
  useContext,
} from 'solid-js';
import { render } from 'solid-js/web';
import type { Api } from '../../api';
import { browserClient } from '../../shared/browser-client';
import { pushStatus } from './push-status';

/** The action's own input type — the selects hold strings the server already constrained. */
type SavePreferencesInput = Parameters<Api['actions']['savePreferences']>[0];

/** One `<option>`: the value the action takes, and the label the server already translated. */
export interface PreferenceOption {
  readonly value: string;
  readonly label: string;
}

/**
 * Every string this module renders. An island's props cross the seam as JSON inside the document,
 * so `t()`'s catalog cannot travel and neither can a callback — the server translates, and the
 * browser is handed text.
 */
export interface PreferenceLabels {
  readonly locale: string;
  readonly localeHelp: string;
  readonly timezone: string;
  readonly timezoneHelp: string;
  readonly theme: string;
  readonly digest: string;
  readonly digestHelp: string;
  readonly save: string;
  readonly saved: string;
  readonly retry: string;
  /** The Web Push button, and what it says after: on, blocked, or not possible here. */
  readonly push: string;
  readonly pushOn: string;
  readonly pushDenied: string;
  readonly pushUnavailable: string;
}

export interface SettingsProps {
  /**
   * The banner this editor opens with. Optional and `idle` when absent, so the page passes nothing
   * and nothing changes — it exists because `saved` and `failed` are states a REVIEWER cannot reach
   * by clicking without a server that really fails, and `x shot --island settings --state
   * save-failed` photographs the retry banner by declaring this prop.
   */
  readonly status?: SaveState;
  /** The request clock as a UTC instant. The preview reformats THIS, never the wall clock. */
  readonly nowIso: string;
  readonly locale: string;
  readonly timezone: string;
  readonly theme: string;
  readonly digestOptIn: boolean;
  readonly locales: readonly PreferenceOption[];
  /** Grouped by region and searchable: the long closed list, where value (an IANA id) ≠ label. */
  readonly timezones: readonly SearchableOption[];
  readonly themes: readonly PreferenceOption[];
  readonly labels: PreferenceLabels;
  /** The design system's own strings, resolved by the server (`uiCatalog(t)`). */
  readonly ui: CatalogSubset;
}

export type SaveState = 'idle' | 'saved' | 'failed';

/**
 * `Intl.DateTimeFormat` with an explicit IANA zone, and not `<DateTime>` — which is what every
 * SERVER render in this app uses, including the shell this module replaces.
 *
 * A size decision, not a style one. An index barrel that does not tree-shake charges the browser
 * chunk for the WHOLE package, so `instant` — a one-line brand cast — would weigh what
 * `@ultimat3/time` weighs, and one `<DateTime>` would weigh what `@ultimat3/ui` weighs; each is
 * several times this island's own compiled markup. No figure is quoted here on purpose: both move
 * whenever a package's `sideEffects` field does, and the numbers this comment used to carry were
 * stale within a release. Measure instead — `buildIslands` in `settings.island.test.ts` reports the
 * chunk. `Intl` is already in the browser and costs nothing. The rule the framework enforces is
 * "no date without an explicit IANA `timeZone`", and this obeys it.
 */
const previewOf = (isoInstant: string, locale: string, zone: string): string =>
  new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(new Date(isoInstant));

function Preferences(props: SettingsProps): JSX.Element {
  const [locale, setLocale] = createSignal(props.locale);
  const [zone, setZone] = createSignal(props.timezone);
  const [theme, setTheme] = createSignal(props.theme);
  const [digestOptIn, setDigestOptIn] = createSignal(props.digestOptIn);
  const [state, setState] = createSignal<SaveState>(props.status ?? 'idle');

  /**
   * Applies before the save lands, and survives one: `system` REMOVES the attribute so the inline
   * head script and the OS decide again, which is why this is an attribute write rather than a
   * value passed down a provider — a provider can only ever set one.
   */
  createEffect(() => {
    const next = theme();
    if (next === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
  });

  /**
   * The typed client, not a raw `fetch`: one naming rule, one transport, and the saved member row
   * reaches the page's record store on the way back. Any refusal is the retry banner.
   */
  const save = async (): Promise<void> => {
    try {
      await browserClient.savePreferences({
        locale: locale() as SavePreferencesInput['locale'],
        tz: zone() as SavePreferencesInput['tz'],
        theme: theme() as SavePreferencesInput['theme'],
        digestOptIn: digestOptIn(),
      });
      setState('saved');
    } catch {
      setState('failed');
    }
  };

  /**
   * Web Push for THIS browser, from a click — a permission prompt no gesture asked for is refused.
   * `@ultimat3/pwa/client` imports nothing; the subscription is saved through the typed client
   * (`subscribePush`, a `pushSubscribe()` action), against whoever is signed in.
   */
  const [push, setPush] = createSignal('');
  const notify = async (): Promise<void> => {
    try {
      const outcome = await subscribeToPush({
        save: (input) => browserClient.subscribePush(input),
      });
      setPush(pushStatus(outcome, props.labels));
    } catch {
      // The save (or the browser's push service) failed: retry wording, never "cannot".
      setPush(pushStatus('failed', props.labels));
    }
  };

  /**
   * The saved zone, when the list names it. A failed options read hands an empty list, and a value
   * no option names is a refusal (`X_UI_INVALID_VALUE`): the editor still renders, and `save` still
   * posts the zone held in the signal.
   */
  const listedZone = (): string | undefined =>
    props.timezones.some((option) => option.value === zone()) ? zone() : undefined;

  const status = (): string => {
    if (state() === 'saved') return props.labels.saved;
    return state() === 'failed' ? props.labels.retry : '';
  };

  return (
    <>
      <label>
        {props.labels.locale}
        <select value={locale()} onChange={(event) => setLocale(event.currentTarget.value)}>
          <For each={props.locales}>
            {(option) => <option value={option.value}>{option.label}</option>}
          </For>
        </select>
        <small>{props.labels.localeHelp}</small>
      </label>

      {/* A `for` label, never a wrapping one: wrapped, every option would land in the name. */}
      <div data-role="timezone">
        <label for="settings-timezone">{props.labels.timezone}</label>
        <SearchableSelect
          id="settings-timezone"
          name="tz"
          required
          options={props.timezones}
          value={listedZone()}
          onChange={setZone}
          aria-describedby="settings-timezone-help"
        />
        <small id="settings-timezone-help">{props.labels.timezoneHelp}</small>
      </div>

      {/* Immediate proof that the zone means something: the request's own instant, as this member
          would read it once the choice above is saved. */}
      <p data-role="preview">{previewOf(props.nowIso, locale(), zone())}</p>

      {/* Three choices, all visible at once: a segmented strip of native radios, one tap each. */}
      <Radio
        legend={props.labels.theme}
        name="theme"
        appearance="segmented"
        options={props.themes}
        value={theme()}
        onChange={(event) => setTheme(event.currentTarget.value)}
      />

      <label>
        <input
          type="checkbox"
          checked={digestOptIn()}
          onChange={(event) => setDigestOptIn(event.currentTarget.checked)}
        />
        {props.labels.digest}
        <small>{props.labels.digestHelp}</small>
      </label>

      <button type="button" onClick={() => void save()}>
        {props.labels.save}
      </button>
      <p data-role="status" role="status" aria-live="polite">
        {status()}
      </p>

      <button type="button" data-role="push" onClick={() => void notify()}>
        {props.labels.push}
      </button>
      <p data-role="push-status" role="status" aria-live="polite">
        {push()}
      </p>
    </>
  );
}

/**
 * The one export the hydration runtime calls — `import(entry).then((m) => m.mount(el, props))`.
 *
 * `mountOver` clears the shell, and the clear is load-bearing: Solid's `render` APPENDS when the
 * container already has children (`insert(el, code(), el.firstChild ? null : undefined)`), so
 * without it the server's saved-state summary stays on screen above a second, editable copy. A
 * render that throws gets the shell back instead of a blank box. An island is compiled with
 * `hydratable: false`, so there is no takeover to resume — the shell is what the server knows.
 */
export function mount(el: HTMLElement, props: SettingsProps): () => void {
  // The design system's reactive seam, from THIS bundle's solid-js — named, never `import *`.
  setSolidRuntime({
    createContext,
    useContext,
    createSignal,
    createMemo,
    createEffect,
    onCleanup,
    createRoot,
  });
  // Returned: the router calls it when it swaps this page out, so every effect this island
  // registered — a socket read, a page-wide hotkey — ends with the page that drew it.
  return mountOver(el, (root) =>
    render(
      () => (
        <UiProvider locale={props.locale} timeZone={props.timezone} t={subsetTranslator(props.ui)}>
          <Preferences {...props} />
        </UiProvider>
      ),
      root,
    ),
  );
}
