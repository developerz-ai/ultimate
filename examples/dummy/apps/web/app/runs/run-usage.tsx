/**
 * What an ended run used, as the console draws it: one term per count `RunUsage` holds. The
 * numbers are formatted for the member's locale here; the terms arrive translated, as labels. The
 * raw record follows, closed, through `JsonView` — what an operator compares against a bill.
 */

import type { RunUsage } from '@postly/db';
import { DescriptionList, JsonView } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './run-console.module.scss';

// A type alias: an island prop must be JSON.
export type UsageLabels = {
  readonly heading: string;
  readonly browser: string;
  readonly navigations: string;
  readonly requests: string;
  readonly bytes: string;
  readonly prompts: string;
  /** Names the raw usage record. */
  readonly raw: string;
};

export interface RunUsageBlockProps {
  readonly usage: RunUsage;
  readonly labels: UsageLabels;
  readonly locale: string;
}

const MS_PER_SECOND = 1000;
const BYTES_PER_KILOBYTE = 1000;

/** The five counts, each in the unit a person reads it in, in the order the labels list them. */
export function usageFigures(usage: RunUsage, locale: string): readonly string[] {
  const count = new Intl.NumberFormat(locale);
  const unit = (name: string) =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: name, maximumFractionDigits: 1 });
  return [
    unit('second').format(usage.browserMs / MS_PER_SECOND),
    count.format(usage.navigations),
    count.format(usage.httpRequests),
    unit('kilobyte').format(usage.bytesIn / BYTES_PER_KILOBYTE),
    count.format(usage.promptsAnswered),
  ];
}

export function RunUsageBlock(props: RunUsageBlockProps): JSX.Element {
  const figures = usageFigures(props.usage, props.locale);
  const terms = [
    props.labels.browser,
    props.labels.navigations,
    props.labels.requests,
    props.labels.bytes,
    props.labels.prompts,
  ];

  return (
    <section class={styles.usage} data-role="run-usage" aria-label={props.labels.heading}>
      <h3 class={styles.usageHeading}>{props.labels.heading}</h3>
      <DescriptionList
        class={styles.figures}
        items={terms.map((term, index) => ({ term, detail: figures[index] }))}
      />
      <JsonView value={props.usage} label={props.labels.raw} open={0} />
    </section>
  );
}
