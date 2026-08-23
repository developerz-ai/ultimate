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

import type { JSX } from 'solid-js';
import { createEffect, createSignal, For } from 'solid-js';
import { render } from 'solid-js/web';

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
}

export interface SettingsProps {
  /**
   * The banner this editor opens with. Optional and `idle` when absent, so the page passes nothing
   * and nothing changes — it exists because `saved` and `failed` are states a REVIEWER cannot reach
   * by clicking without a server that really fails, and `x shot --island settings --state
   * save-failed` photographs the retry banner by declaring this prop.
   */
  readonly status?: SaveState;
  /** `derivePath('savePreferences')`, minted on the server: one namer for the action's path. */
  readonly endpoint: string;
  /** The request clock as a UTC instant. The preview reformats THIS, never the wall clock. */
  readonly nowIso: string;
  readonly locale: string;
  readonly timezone: string;
  readonly theme: string;
  readonly digestOptIn: boolean;
  readonly locales: readonly PreferenceOption[];
  readonly timezones: readonly PreferenceOption[];
  readonly themes: readonly PreferenceOption[];
  readonly labels: PreferenceLabels;
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
   * A plain `fetch` to the path the server minted, not the typed client: `rpc()` pulls
   * `@ultimat3/action` into the chunk, which is 14.8 kB — still comparable to this whole
   * island, and it was 42.6 kB until 2026-08-23. The naming rule
   * is still the framework's; only the transport is second.
   */
  const save = async (): Promise<void> => {
    const response = await fetch(props.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        locale: locale(),
        tz: zone(),
        theme: theme(),
        digestOptIn: digestOptIn(),
      }),
    });
    setState(response.ok ? 'saved' : 'failed');
  };

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

      <label>
        {props.labels.timezone}
        <select value={zone()} onChange={(event) => setZone(event.currentTarget.value)}>
          <For each={props.timezones}>
            {(option) => <option value={option.value}>{option.label}</option>}
          </For>
        </select>
        <small>{props.labels.timezoneHelp}</small>
      </label>

      {/* Immediate proof that the zone means something: the request's own instant, as this member
          would read it once the choice above is saved. */}
      <p data-role="preview">{previewOf(props.nowIso, locale(), zone())}</p>

      <label>
        {props.labels.theme}
        <select value={theme()} onChange={(event) => setTheme(event.currentTarget.value)}>
          <For each={props.themes}>
            {(option) => <option value={option.value}>{option.label}</option>}
          </For>
        </select>
      </label>

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
    </>
  );
}

/**
 * The one export the hydration runtime calls — `import(entry).then((m) => m.mount(el, props))`.
 *
 * The shell goes first, and that line is load-bearing: Solid's `render` APPENDS when the container
 * already has children (`insert(el, code(), el.firstChild ? null : undefined)`), so without it the
 * server's saved-state summary stays on screen above a second copy of the same values that can be
 * edited. An island is compiled with `hydratable: false`, so there is no takeover to resume — the
 * shell is what the server knows, and this is what replaces it once a browser can do more.
 */
export function mount(el: HTMLElement, props: SettingsProps): void {
  el.textContent = '';
  render(() => <Preferences {...props} />, el);
}
