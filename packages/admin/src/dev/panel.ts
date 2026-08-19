// What a /_x panel is. One panel per file, each one an introspection call plus the shape it
// draws — and because `data()` returns plain JSON, `--json` and the rendered tab are the
// same facts by construction.

import { renderThrowable, stringField } from '@ultimat3/core';
import type { DevSources } from './facts';

export interface DevPanel<Data = unknown> {
  /** URL segment under `/_x`, and the key `devDashboard().json(key)` takes. */
  readonly key: string;
  readonly titleKey: string;
  /**
   * i18n key for the question this panel exists to kill, rendered as the tab's subtitle —
   * `t(questionKey)`, never a literal sitting beside `titleKey`. The two are siblings under the
   * panel's own namespace: `dev.panel.jobs.title` and `dev.panel.jobs.question`.
   */
  readonly questionKey: string;
  data(sources: DevSources, params: URLSearchParams): Promise<Data>;
}

export type PanelPayload =
  | { readonly panel: string; readonly ok: true; readonly data: unknown }
  | {
      readonly panel: string;
      readonly ok: false;
      readonly error: { readonly code: string; readonly cause: string; readonly fix: string };
    };

/**
 * A panel whose source is not wired must say so in the panel, with the fix line — the same
 * payload the CLI prints. A blank tab would read as "nothing is happening".
 */
export async function panelPayload(
  panel: DevPanel,
  sources: DevSources,
  params: URLSearchParams,
): Promise<PanelPayload> {
  try {
    return { panel: panel.key, ok: true, data: await panel.data(sources, params) };
  } catch (error) {
    // Core's total readers, not `String(error)` and a raw property read. This catch owes its
    // caller a `/_x` RESPONSE: `String(Object.create(null))` throws, and so does a getter or a
    // Proxy trap on `error.code` — either turns a rendered failure panel into an unhandled
    // rejection on the request. `stringField` answers `undefined` for absent, wrong type and
    // threw alike, which is what every branch below already meant.
    return {
      panel: panel.key,
      ok: false,
      error: {
        code: stringField(error, 'code') ?? 'X_NOT_IMPLEMENTED',
        cause: stringField(error, 'cause') ?? renderThrowable(error),
        fix: stringField(error, 'fix') ?? 'x dev --help',
      },
    };
  }
}
