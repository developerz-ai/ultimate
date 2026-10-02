/**
 * The run console, in the browser: the one module of `/runs` a browser downloads.
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

import { useQuery } from '@ultimat3/realtime';
import { AsyncRegion, Button, Input, setSolidRuntime, UiProvider } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  useContext,
} from 'solid-js';
import { render } from 'solid-js/web';
import { browserClient } from '../../shared/browser-client';
import { type UiStrings, uiTranslator } from '../../shared/ui-strings';
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
};

export interface RunConsoleProps {
  readonly orgId: string;
  readonly locale: string;
  readonly zone: string;
  readonly connections: readonly ConnectionOption[];
  readonly labels: RunConsoleLabels;
  /** The `ui.*` strings `AsyncRegion`'s failure branch reads (`shared/ui-strings.ts`). */
  readonly ui: UiStrings;
  readonly run?: RunHandle;
  /** Events to draw instead of subscribing. The states file's, never the page's. */
  readonly preview?: readonly RunEventRow[];
}

interface RunBodyProps {
  readonly events: readonly RunEventRow[];
  readonly model: ConsoleModel;
  readonly console: RunConsoleProps;
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
    <RunBody events={orderedEvents(rows)} model={props.model} console={props.console} />
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
            <RunBody events={orderedEvents(props.preview)} model={model} console={props} />
          )
        }
      </Show>
    </div>
  );
}

/**
 * The one export the hydration runtime calls. Solid's `render` APPENDS when the container already
 * has children, so the server's shell goes first — `settings.island.tsx`'s rule, verbatim.
 */
export function mount(el: HTMLElement, props: RunConsoleProps): void {
  // The design system's reactive seam, from THIS bundle's solid-js — named, never `import *`.
  setSolidRuntime({ createContext, useContext, createSignal, createMemo, createEffect, onCleanup });
  el.textContent = '';
  render(
    () => (
      <UiProvider
        locale={props.locale}
        timeZone={props.zone}
        t={uiTranslator(props.ui, props.locale)}
      >
        <RunConsole {...props} />
      </UiProvider>
    ),
    el,
  );
}
