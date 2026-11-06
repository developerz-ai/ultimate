// Single responsibility: the `clientErrors` block of `app.config.ts` — whether `app/` documents
// carry the browser reporter (`@ultimat3/cli`'s `/x-client-errors.js`), who may file through it,
// and whether documents beacon real-user timings (`vitals`) through the same door. Shape, merge and
// screen are one subject, and `config.ts` is at its 500-line ceiling.

import { countIssue } from './config-count';
import { booleanIssue, oneOfIssue } from './config-shape';
import { describeValue } from './error-render';

/** The surfaces a document is rendered for. `site/` is listed by choice: a beacon costs it bytes. */
export const CLIENT_VITALS_SURFACES = ['app', 'site'] as const;

export type ClientVitalsSurface = (typeof CLIENT_VITALS_SURFACES)[number];

/**
 * OFF BY DEFAULT, and anonymous: a timing carries no actor, so it needs no sign-in and lands as a
 * histogram sample (`web_vital_seconds`, `web_vital_cls`), never a row. `sampleRate` is the share
 * of page views that beacon — decided once per view, in the browser. `surfaces` defaults to
 * `app/` alone: `site/` is the static path, and it pays for the script only when it is listed.
 */
export interface ClientVitalsConfig {
  readonly enabled: boolean;
  readonly sampleRate: number;
  readonly surfaces: readonly ClientVitalsSurface[];
}

/**
 * OFF BY DEFAULT: a new public write route is the app's decision, as `pwa.push` is. `anonymous`
 * is refused by default too — crash text is input to whoever reads the monitor, and an open door
 * lets anyone write there. `perMinute` is the route's own bucket, per actor or, for an anonymous
 * caller, per address, spent through the app's rate-limit store.
 */
export interface ClientErrorsConfig {
  readonly enabled: boolean;
  readonly anonymous: boolean;
  readonly perMinute: number;
  readonly vitals: ClientVitalsConfig;
}

export const CLIENT_VITALS_DEFAULTS: ClientVitalsConfig = Object.freeze({
  enabled: false,
  sampleRate: 0.1,
  surfaces: Object.freeze(['app'] as const),
});

export const CLIENT_ERRORS_DEFAULTS: ClientErrorsConfig = Object.freeze({
  enabled: false,
  anonymous: false,
  perMinute: 30,
  vitals: CLIENT_VITALS_DEFAULTS,
});

export interface ClientErrorsSection {
  readonly clientErrors: ClientErrorsConfig;
}

export interface ClientErrorsSectionInput {
  readonly clientErrors?:
    | {
        readonly enabled?: boolean | undefined;
        readonly anonymous?: boolean | undefined;
        readonly perMinute?: number | undefined;
        readonly vitals?:
          | {
              readonly enabled?: boolean | undefined;
              readonly sampleRate?: number | undefined;
              readonly surfaces?: readonly ClientVitalsSurface[] | undefined;
            }
          | undefined;
      }
    | undefined;
}

/** Key by key, the last layer that said one wins it — every section's rule. */
export function mergeClientErrors(
  layers: readonly ClientErrorsSectionInput[],
): ClientErrorsSection {
  let { enabled, anonymous, perMinute } = CLIENT_ERRORS_DEFAULTS;
  let vitals: ClientVitalsConfig = CLIENT_VITALS_DEFAULTS;
  for (const layer of layers) {
    const said = layer.clientErrors;
    if (said?.enabled !== undefined) enabled = said.enabled;
    if (said?.anonymous !== undefined) anonymous = said.anonymous;
    if (said?.perMinute !== undefined) perMinute = said.perMinute;
    // One level further, by the same rule: an overlay naming `surfaces` keeps the base's rate.
    const timings = said?.vitals;
    if (timings?.enabled !== undefined) vitals = { ...vitals, enabled: timings.enabled };
    if (timings?.sampleRate !== undefined) vitals = { ...vitals, sampleRate: timings.sampleRate };
    if (timings?.surfaces !== undefined) vitals = { ...vitals, surfaces: timings.surfaces };
  }
  return { clientErrors: { enabled, anonymous, perMinute, vitals } };
}

/** A share of page views: a finite number in 0–1. `0` is legal — sampled out, still declared. */
function rateIssue(key: string, value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
    return undefined;
  }
  const shown = typeof value === 'number' ? `${value}` : describeValue(value);
  return `${key} must be a number from 0 to 1 (the share of page views that report), not ${shown}`;
}

/** At least one listed surface: an empty list is `enabled: false` spelled a second way. */
function surfacesIssues(key: string, value: unknown, issues: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${key} must list at least one of ${CLIENT_VITALS_SURFACES.join(', ')}`);
    return;
  }
  for (const surface of value) {
    const issue = oneOfIssue(key, surface, CLIENT_VITALS_SURFACES);
    if (issue !== undefined) issues.push(issue);
  }
}

/** Appends every refusal the section earns to `issues`, `config.ts`' one list. */
export function clientErrorsIssues(config: ClientErrorsSection, issues: string[]): void {
  // `unknown`: an untyped config file reaches this validator with whatever it wrote.
  const block: Readonly<Record<keyof ClientErrorsConfig, unknown>> = config.clientErrors;
  const vitals: Readonly<Record<keyof ClientVitalsConfig, unknown>> = config.clientErrors.vitals;
  for (const issue of [
    booleanIssue('clientErrors.enabled', block.enabled),
    booleanIssue('clientErrors.anonymous', block.anonymous),
    // Zero is refused, not read as "off": a bucket of nothing refuses every report, and `enabled`
    // is the switch that says off.
    countIssue('clientErrors.perMinute', block.perMinute, 1),
    booleanIssue('clientErrors.vitals.enabled', vitals.enabled),
    rateIssue('clientErrors.vitals.sampleRate', vitals.sampleRate),
  ]) {
    if (issue !== undefined) issues.push(issue);
  }
  surfacesIssues('clientErrors.vitals.surfaces', vitals.surfaces, issues);
}
