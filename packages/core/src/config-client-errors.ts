// Single responsibility: the `clientErrors` block of `app.config.ts` — whether `app/` documents
// carry the browser reporter (`@ultimat3/cli`'s `/x-client-errors.js`) and who may file through
// it. Shape, merge and screen are one subject, and `config.ts` is at its 500-line ceiling.

import { countIssue } from './config-count';
import { booleanIssue } from './config-shape';

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
}

export const CLIENT_ERRORS_DEFAULTS: ClientErrorsConfig = Object.freeze({
  enabled: false,
  anonymous: false,
  perMinute: 30,
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
      }
    | undefined;
}

/** Key by key, the last layer that said one wins it — every section's rule. */
export function mergeClientErrors(
  layers: readonly ClientErrorsSectionInput[],
): ClientErrorsSection {
  let { enabled, anonymous, perMinute } = CLIENT_ERRORS_DEFAULTS;
  for (const layer of layers) {
    const said = layer.clientErrors;
    if (said?.enabled !== undefined) enabled = said.enabled;
    if (said?.anonymous !== undefined) anonymous = said.anonymous;
    if (said?.perMinute !== undefined) perMinute = said.perMinute;
  }
  return { clientErrors: { enabled, anonymous, perMinute } };
}

/** Appends every refusal the section earns to `issues`, `config.ts`' one list. */
export function clientErrorsIssues(config: ClientErrorsSection, issues: string[]): void {
  // `unknown`: an untyped config file reaches this validator with whatever it wrote.
  const block: Readonly<Record<keyof ClientErrorsConfig, unknown>> = config.clientErrors;
  for (const issue of [
    booleanIssue('clientErrors.enabled', block.enabled),
    booleanIssue('clientErrors.anonymous', block.anonymous),
    // Zero is refused, not read as "off": a bucket of nothing refuses every report, and `enabled`
    // is the switch that says off.
    countIssue('clientErrors.perMinute', block.perMinute, 1),
  ]) {
    if (issue !== undefined) issues.push(issue);
  }
}
