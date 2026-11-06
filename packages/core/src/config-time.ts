// Single responsibility: the `time` block of `app.config.ts` — whether `app/` documents carry the
// zone script that tells the next request the visitor's zone. No default zone lives here, ever:
// every format call names its zone. Shape, merge and screen are one subject; `config.ts` is full.

import { booleanIssue } from './config-shape';

/**
 * OFF BY DEFAULT: `detect` writes a cookie (`x_timezone_detected`) on every `app/` document, and a
 * cookie is the app's decision. On, a visitor's second page renders in their zone with no picker.
 */
export interface AppTimeConfig {
  readonly detect: boolean;
}

export const TIME_DEFAULTS: AppTimeConfig = Object.freeze({ detect: false });

export interface TimeSection {
  readonly time: AppTimeConfig;
}

export interface TimeSectionInput {
  readonly time?: { readonly detect?: boolean | undefined } | undefined;
}

/** The last layer that said `detect` wins it — every section's rule. */
export function mergeTime(layers: readonly TimeSectionInput[]): TimeSection {
  let { detect } = TIME_DEFAULTS;
  for (const layer of layers) {
    if (layer.time?.detect !== undefined) detect = layer.time.detect;
  }
  return { time: { detect } };
}

/** Appends every refusal the section earns to `issues`, `config.ts`' one list. */
export function timeIssues(config: TimeSection, issues: string[]): void {
  // `unknown`: an untyped config file reaches this validator with whatever it wrote.
  const detect: unknown = config.time.detect;
  const issue = booleanIssue('time.detect', detect);
  if (issue !== undefined) issues.push(issue);
}
