/**
 * One run, drawn from its events: the state line, then each event in `seq` order. Presentation
 * only — no hook, no fetch, no signal — so the island renders it over a live list and a test
 * renders it over a literal one.
 *
 * Every word arrives as a label: an island's props cross as JSON, so the server translates. An
 * event's `kind` picks the sentence; its `message` is a detail (a row count, an `X_*` code) and
 * is never shown as prose.
 */

import { DateTime, TerminalView, Timeline, type Tone } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { Show } from 'solid-js';
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
  /** Names the run's raw output. */
  readonly output: string;
};

export interface RunTimelineProps {
  /** Already ordered and de-duplicated (`orderedEvents`). */
  readonly events: readonly RunEventRow[];
  readonly labels: RunLabels;
  readonly locale: string;
  /** The member's IANA zone — every instant here is formatted in it, never the device's. */
  readonly zone: string;
}

const SGR_RED = '\u001b[31m';
const SGR_RESET = '\u001b[0m';

/**
 * The run as a transcript a member can copy into a support ticket: one line per step, in the
 * catalog's words, a stop in red. The same facts the timeline shows and no others — a `message`
 * is a detail this console never prints as prose, so a stop says its code (or, when the
 * connection was busy, the sentence) and an end says its count. Written with SGR so
 * `TerminalView` is what turns colour into roles.
 */
export function runOutput(events: readonly RunEventRow[], labels: RunLabels): string {
  return events
    .flatMap((event) => {
      if (event.kind === 'usage') return [];
      const seq = String(event.seq).padStart(3, ' ');
      const words = labels.kinds[event.kind];
      if (event.kind === 'failed') {
        const why = event.message === BUSY_CODE ? labels.busy : event.message;
        return [`${SGR_RED}${seq} ${words}: ${why}${SGR_RESET}`];
      }
      if (event.kind === 'done') {
        return [`${seq} ${words}: ${pluralText(labels.accounts, Number(event.message))}`];
      }
      return [`${seq} ${words}`];
    })
    .join('\n');
}

/** The marker's colour per step. The words are the catalog's; which tone a step is, the app's. */
const PHASE_TONE: Readonly<Record<Phase, Tone>> = {
  prompt: 'warning',
  answered: 'info',
  navigated: 'neutral',
  extracted: 'neutral',
  done: 'success',
  failed: 'danger',
};

/** What a stop or an end adds under its step: the code (or the busy sentence), or the count. */
function phaseDetail(event: RunEventRow, labels: RunLabels): JSX.Element | undefined {
  if (event.kind === 'failed') {
    return event.message === BUSY_CODE ? (
      <span data-role="run-busy">{labels.busy}</span>
    ) : (
      <code>{event.message}</code>
    );
  }
  if (event.kind === 'done') {
    return (
      <span data-role="run-summary">{pluralText(labels.accounts, Number(event.message))}</span>
    );
  }
  return undefined;
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
      {/* `Timeline`: when, what, a marker in the step's tone. Keyed by `seq` (`data-key`). */}
      <div data-role="run-events">
        <Timeline
          label={props.labels.events}
          items={phases().map((event) => ({
            key: String(event.seq),
            title: <span data-kind={event.kind}>{props.labels.kinds[event.kind]}</span>,
            when: (
              <DateTime
                value={event.at}
                timeZone={props.zone}
                locale={props.locale}
                timeStyle="medium"
              />
            ),
            tone: PHASE_TONE[event.kind],
            detail: phaseDetail(event, props.labels),
          }))}
        />
      </div>
      <Show when={props.events.length > 0}>
        <TerminalView
          text={runOutput(props.events, props.labels)}
          label={props.labels.output}
          rows={8}
        />
      </Show>
      <Show when={runUsage(props.events)}>
        {(usage) => (
          <RunUsageBlock usage={usage()} labels={props.labels.usage} locale={props.locale} />
        )}
      </Show>
    </section>
  );
}
