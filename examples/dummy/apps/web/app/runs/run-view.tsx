/**
 * One run, drawn from its events: the state line, then each event in `seq` order. Presentation
 * only — no hook, no fetch, no signal — so the island renders it over a live list and a test
 * renders it over a literal one.
 *
 * Every word arrives as a label: an island's props cross as JSON, so the server translates. An
 * event's `kind` picks the sentence; its `message` is a detail (a row count, an `X_*` code) and
 * is never shown as prose.
 */

import { DateTime } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { For, Show } from 'solid-js';
import { type PluralForms, pluralText } from '../../shared/plural-text';
import styles from './run-console.module.scss';
import {
  BUSY_CODE,
  type ConsoleState,
  consoleState,
  type Phase,
  type RunEventRow,
  runUsage,
} from './run-state';
import { RunUsageBlock, type UsageLabels } from './run-usage';

// Type aliases, not interfaces: an island prop must be JSON, and only an object TYPE is
// assignable to the index signature `JsonValue` checks it against.
export type RunLabels = {
  readonly states: Readonly<Record<ConsoleState, string>>;
  readonly kinds: Readonly<Record<Phase, string>>;
  /** Said instead of the code when the connection was busy: the run never started. */
  readonly busy: string;
  readonly usage: UsageLabels;
  /** Names the list for a screen reader: the rows carry no heading of their own. */
  readonly events: string;
  /** Every plural form of "N accounts read": the count is known only when the run ends. */
  readonly accounts: PluralForms;
};

export interface RunTimelineProps {
  /** Already ordered and de-duplicated (`orderedEvents`). */
  readonly events: readonly RunEventRow[];
  readonly labels: RunLabels;
  readonly locale: string;
  /** The member's IANA zone — every instant here is formatted in it, never the device's. */
  readonly zone: string;
}

export function RunTimeline(props: RunTimelineProps): JSX.Element {
  const state = (): ConsoleState => consoleState(props.events);
  // `usage` is said once, as its block, never as a step of the run.
  const phases = (): readonly (RunEventRow & { readonly kind: Phase })[] =>
    props.events.filter((event): event is RunEventRow & { kind: Phase } => event.kind !== 'usage');

  return (
    <section class={styles.run} data-role="run" data-state={state()}>
      <p class={styles.status} data-role="run-state" role="status">
        {props.labels.states[state()]}
      </p>
      <ol class={styles.events} data-role="run-events" aria-label={props.labels.events}>
        <For each={phases()}>
          {(event) => (
            <li class={styles.event} data-seq={event.seq} data-kind={event.kind}>
              <span class={styles.seq}>{event.seq}</span>
              <span>{props.labels.kinds[event.kind]}</span>
              <DateTime
                value={event.at}
                timeZone={props.zone}
                locale={props.locale}
                timeStyle="medium"
              />
              <Show when={event.kind === 'failed'}>
                <Show
                  when={event.message === BUSY_CODE}
                  fallback={<code class={styles.detail}>{event.message}</code>}
                >
                  <span class={styles.detail} data-role="run-busy">
                    {props.labels.busy}
                  </span>
                </Show>
              </Show>
              <Show when={event.kind === 'done'}>
                <span class={styles.detail} data-role="run-summary">
                  {pluralText(props.labels.accounts, Number(event.message))}
                </span>
              </Show>
            </li>
          )}
        </For>
      </ol>
      <Show when={runUsage(props.events)}>
        {(usage) => (
          <RunUsageBlock usage={usage()} labels={props.labels.usage} locale={props.locale} />
        )}
      </Show>
    </section>
  );
}
