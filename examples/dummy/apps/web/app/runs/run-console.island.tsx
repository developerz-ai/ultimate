/**
 * The run console, in the browser: the one module of `/runs` a browser downloads, the "created
 * between" filter at its head included (`created-filter.tsx`, the calendar on a fine pointer).
 *
 * `useQuery(LIVE_RUN_EVENTS, { orgId, runId })` — the one read hook. The query is declared `live`,
 * so a row the job writes arrives over the page's one socket and the list re-renders without a
 * reload. A hook's input is read once, so each run is its own `RunStream`, keyed by the run.
 *
 * Every write goes through `browserClient` (`createConsole`): no `fetch`, no socket and no store
 * is built here. Rendered through `AsyncRegion`, which owns the read's own states; what the run is
 * doing is `RunTimeline`'s, read off the events.
 *
 * `preview` exists for `run-console.island.states.ts` and only for it: the shot harness refuses a
 * `WebSocket`, and none of the five states can be held still by clicking. The page passes none.
 */

import type { CatalogSubset } from '@ultimat3/i18n/subset';
import { subsetTranslator } from '@ultimat3/i18n/subset';
import { useQuery } from '@ultimat3/realtime';
import { mountOver } from '@ultimat3/render/client';
import {
  AsyncRegion,
  Button,
  Input,
  type LogLine,
  LogViewer,
  SplitPane,
  setSolidRuntime,
  UiProvider,
} from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import {
  createContext,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  onCleanup,
  Show,
  useContext,
} from 'solid-js';
import { render } from 'solid-js/web';
import { browserClient } from '../../shared/browser-client';
import { CreatedFilter, type CreatedFilterProps } from './created-filter';
import styles from './run-console.module.scss';
import type { ConnectionOption, ConsoleFault, ConsoleModel, RunHandle } from './run-console-model';
import { createConsole } from './run-console-model';
import type { RunEventRow } from './run-state';
import { consoleState, isLive, LIVE_RUN_EVENTS, orderedEvents, waitingPrompt } from './run-state';
import { type RunLabels, RunTimeline } from './run-view';

// Type aliases, not interfaces: an island prop must be JSON.
export type RunConsoleLabels = RunLabels & {
  readonly connection: string;
  readonly start: string;
  readonly cancel: string;
  /** Before any run: what this page is for. */
  readonly idle: string;
  readonly connectHeading: string;
  readonly connectName: string;
  readonly connectCredential: string;
  readonly connectSubmit: string;
  readonly promptLabel: string;
  readonly promptSubmit: string;
  /** One sentence per write that can fail — the console says which did not happen. */
  readonly faults: Readonly<Record<ConsoleFault, string>>;
  /** Names the event log, and the separator between it and the run. */
  readonly log: string;
  readonly resize: string;
};

export interface RunConsoleProps {
  readonly orgId: string;
  readonly locale: string;
  readonly zone: string;
  readonly connections: readonly ConnectionOption[];
  readonly labels: RunConsoleLabels;
  /** The design system's `ui.*` strings, resolved on the server (`uiCatalog(t)`): a `t` cannot travel. */
  readonly ui: CatalogSubset;
  /**
   * The "created between" filter, drawn at the console's head. HERE rather than its own island:
   * a second island on the page carried its own Solid and `UiProvider`, 58,159 B, where the
   * calendar inside this one costs 16,758 (measured 2026-11-06, `x build --target static`).
   */
  readonly filter: CreatedFilterProps;
  readonly run?: RunHandle;
  /** Events to draw instead of subscribing. The states file's, never the page's. */
  readonly preview?: readonly RunEventRow[];
}

interface RunBodyProps {
  readonly events: readonly RunEventRow[];
  readonly model: ConsoleModel;
  readonly console: RunConsoleProps;
}

/**
 * The run's events as a log a reader can filter and follow: one line per step, a stop as an error.
 * `usage` is said once, as its block in the timeline, never as a line.
 */
export function eventLog(events: readonly RunEventRow[], labels: RunConsoleLabels): LogLine[] {
  return events.flatMap((event) =>
    event.kind === 'usage'
      ? []
      : [
          {
            id: event.id,
            at: event.at,
            level: event.kind === 'failed' ? ('error' as const) : ('info' as const),
            text:
              event.message === ''
                ? labels.kinds[event.kind]
                : `${labels.kinds[event.kind]} · ${event.message}`,
          },
        ],
  );
}

/**
 * The log beside the run: `SplitPane` puts the filterable event log at the start and the timeline
 * with its controls at the end, one column on a phone. The split lives for the page: storage is
 * this app's to choose, and a console has nothing worth keeping across visits.
 */
function RunPanes(props: RunBodyProps): JSX.Element {
  return (
    <SplitPane
      defaultValue={40}
      min={25}
      max={75}
      label={props.console.labels.resize}
      start={
        <LogViewer
          lines={eventLog(props.events, props.console.labels)}
          label={props.console.labels.log}
        />
      }
      end={<RunBody events={props.events} model={props.model} console={props.console} />}
    />
  );
}

/** The timeline, and the two controls a run in flight has: answer its prompt, or cancel it. */
function RunBody(props: RunBodyProps): JSX.Element {
  const [code, setCode] = createSignal('');
  const labels = (): RunConsoleLabels => props.console.labels;

  return (
    <>
      <RunTimeline
        events={props.events}
        labels={labels()}
        locale={props.console.locale}
        zone={props.console.zone}
      />
      <Show when={waitingPrompt(props.events)}>
        {(prompt) => (
          <form
            class={styles.prompt}
            data-role="prompt"
            onSubmit={(event) => {
              event.preventDefault();
              void props.model.answer(prompt(), code());
            }}
          >
            <Input
              aria-label={labels().promptLabel}
              autocomplete="one-time-code"
              inputmode="numeric"
              value={code()}
              onInput={(event) => setCode(event.currentTarget.value)}
            />
            <Button type="submit" disabled={props.model.busy()}>
              {labels().promptSubmit}
            </Button>
          </form>
        )}
      </Show>
      <Show when={isLive(consoleState(props.events))}>
        <Button
          type="button"
          variant="ghost"
          id="run-cancel"
          disabled={props.model.busy()}
          onClick={() => void props.model.cancel()}
        >
          {labels().cancel}
        </Button>
      </Show>
    </>
  );
}

/** One run's live events. Its own component because a hook's input is read once, per run. */
function RunStream(props: Omit<RunBodyProps, 'events'> & { readonly run: RunHandle }): JSX.Element {
  const events = useQuery<RunEventRow>(
    { name: LIVE_RUN_EVENTS, live: true },
    { orgId: props.console.orgId, runId: props.run.runId },
  );
  onCleanup(() => events.release());
  const body = (rows: readonly RunEventRow[]): JSX.Element => (
    <RunPanes events={orderedEvents(rows)} model={props.model} console={props.console} />
  );

  return (
    <AsyncRegion
      state={events()}
      reserve={{ lines: 3 }}
      // No events yet is a state of the RUN — pending — and never an empty screen.
      empty={() => body([])}
      ready={body}
    />
  );
}

/** Connecting a site: the form shown until the org has one to run. */
function ConnectForm(props: { readonly model: ConsoleModel; readonly labels: RunConsoleLabels }) {
  const [name, setName] = createSignal('');
  const [credential, setCredential] = createSignal('');

  return (
    <form
      class={styles.field}
      data-role="connect"
      onSubmit={(event) => {
        event.preventDefault();
        void props.model.connect(name(), credential());
      }}
    >
      <h2>{props.labels.connectHeading}</h2>
      <Input
        aria-label={props.labels.connectName}
        value={name()}
        onInput={(event) => setName(event.currentTarget.value)}
      />
      <Input
        aria-label={props.labels.connectCredential}
        type="password"
        autocomplete="off"
        value={credential()}
        onInput={(event) => setCredential(event.currentTarget.value)}
      />
      <Button type="submit" disabled={props.model.busy()}>
        {props.labels.connectSubmit}
      </Button>
    </form>
  );
}

export function RunConsole(props: RunConsoleProps): JSX.Element {
  const model = createConsole(props, browserClient);
  const fault = (): string | undefined => {
    const what = model.fault();
    return what === null ? undefined : props.labels.faults[what];
  };

  return (
    <div class={styles.console}>
      <CreatedFilter {...props.filter} />
      <Show
        when={model.connections().length > 0}
        fallback={<ConnectForm model={model} labels={props.labels} />}
      >
        <div class={styles.toolbar}>
          <label class={styles.field}>
            {props.labels.connection}
            <select
              data-role="connection"
              onChange={(event) => model.select(event.currentTarget.value)}
            >
              <For each={model.connections()}>
                {(option) => (
                  <option value={option.id} selected={option.id === model.selected()}>
                    {option.label}
                  </option>
                )}
              </For>
            </select>
          </label>
          <Button
            type="button"
            id="run-start"
            disabled={model.busy()}
            onClick={() => void model.start()}
          >
            {props.labels.start}
          </Button>
        </div>
      </Show>
      <Show when={fault()}>
        {(message) => (
          <p class={styles.fault} data-role="fault" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={model.run()} keyed fallback={<p data-role="idle">{props.labels.idle}</p>}>
        {(run) =>
          props.preview === undefined ? (
            <RunStream run={run} model={model} console={props} />
          ) : (
            <RunPanes events={orderedEvents(props.preview)} model={model} console={props} />
          )
        }
      </Show>
    </div>
  );
}

/**
 * The one export the hydration runtime calls. `mountOver` clears the server's shell (Solid's
 * `render` APPENDS) and puts it back if the render throws — `settings.island.tsx`'s rule, verbatim.
 */
export function mount(el: HTMLElement, props: RunConsoleProps): () => void {
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
        <UiProvider locale={props.locale} timeZone={props.zone} t={subsetTranslator(props.ui)}>
          <RunConsole {...props} />
        </UiProvider>
      ),
      root,
    ),
  );
}
