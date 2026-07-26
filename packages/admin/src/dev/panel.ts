// What a /_x panel is. One panel per file, each one an introspection call plus the shape it
// draws — and because `data()` returns plain JSON, `--json` and the rendered tab are the
// same facts by construction.

import type { DevSources } from './facts';

export interface DevPanel<Data = unknown> {
  /** URL segment and `--json` selector: `x dev --panel routes --json`. */
  readonly key: string;
  readonly titleKey: string;
  /** The question this panel exists to kill. Rendered as the tab's subtitle. */
  readonly question: string;
  data(sources: DevSources, params: URLSearchParams): Promise<Data>;
}

export type PanelPayload =
  | { readonly panel: string; readonly ok: true; readonly data: unknown }
  | {
      readonly panel: string;
      readonly ok: false;
      readonly error: { readonly code: string; readonly cause: string; readonly fix: string };
    };

interface ErrorFields {
  readonly code?: unknown;
  readonly cause?: unknown;
  readonly fix?: unknown;
}

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
    const fields = (error ?? {}) as ErrorFields;
    return {
      panel: panel.key,
      ok: false,
      error: {
        code: typeof fields.code === 'string' ? fields.code : 'X_NOT_IMPLEMENTED',
        cause:
          typeof fields.cause === 'string'
            ? fields.cause
            : error instanceof Error
              ? error.message
              : String(error),
        fix: typeof fields.fix === 'string' ? fields.fix : 'x dev --help',
      },
    };
  }
}
