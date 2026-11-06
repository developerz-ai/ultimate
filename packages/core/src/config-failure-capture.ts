// Single responsibility: the `failureCapture` block of `app.config.ts` — whether a 5xx at `invoke`
// keeps a replayable bundle (input, actor, flags, the rows the code read) for `x repro`, and how
// much of one. Shape, merge and screen are one subject, and `config.ts` is at its line ceiling.

import { countIssue } from './config-count';
import { booleanIssue } from './config-shape';

/**
 * OFF BY DEFAULT: storing what a user sent is the app's decision, as `clientErrors` is. `x dev`
 * turns it on for its own process. `perHour` bounds bundles per fingerprint per hour, per process;
 * `maxRows` and `maxBytes` bound one bundle — past either it is stored truncated, and says so.
 */
export interface FailureCaptureConfig {
  readonly enabled: boolean;
  readonly perHour: number;
  readonly maxRows: number;
  readonly maxBytes: number;
}

export const FAILURE_CAPTURE_DEFAULTS: FailureCaptureConfig = Object.freeze({
  enabled: false,
  perHour: 5,
  maxRows: 50,
  maxBytes: 64 * 1024,
});

export interface FailureCaptureSection {
  readonly failureCapture: FailureCaptureConfig;
}

export interface FailureCaptureSectionInput {
  readonly failureCapture?:
    | {
        readonly enabled?: boolean | undefined;
        readonly perHour?: number | undefined;
        readonly maxRows?: number | undefined;
        readonly maxBytes?: number | undefined;
      }
    | undefined;
}

/** Key by key, the last layer that said one wins it — every section's rule. */
export function mergeFailureCapture(
  layers: readonly FailureCaptureSectionInput[],
): FailureCaptureSection {
  let { enabled, perHour, maxRows, maxBytes } = FAILURE_CAPTURE_DEFAULTS;
  for (const layer of layers) {
    const said = layer.failureCapture;
    if (said?.enabled !== undefined) enabled = said.enabled;
    if (said?.perHour !== undefined) perHour = said.perHour;
    if (said?.maxRows !== undefined) maxRows = said.maxRows;
    if (said?.maxBytes !== undefined) maxBytes = said.maxBytes;
  }
  return { failureCapture: { enabled, perHour, maxRows, maxBytes } };
}

/** Appends every refusal the section earns to `issues`, `config.ts`' one list. */
export function failureCaptureIssues(config: FailureCaptureSection, issues: string[]): void {
  // `unknown`: an untyped config file reaches this validator with whatever it wrote.
  const block: Readonly<Record<keyof FailureCaptureConfig, unknown>> = config.failureCapture;
  // Zero is refused, not read as "off": `enabled` is the switch that says off.
  for (const issue of [
    booleanIssue('failureCapture.enabled', block.enabled),
    countIssue('failureCapture.perHour', block.perHour, 1),
    countIssue('failureCapture.maxRows', block.maxRows, 1),
    countIssue('failureCapture.maxBytes', block.maxBytes, 1),
  ]) {
    if (issue !== undefined) issues.push(issue);
  }
}
