// The two ways `x design research` refuses, beside their throwers. Codes and titles are registered
// in `error-codes.ts`, the runnable line per code in `mcp-errors.ts`.

import { renderCauseValue, renderFixShellArg, UltimateError } from '@ultimat3/core';

/**
 * A reference URL — typed, followed, or reached by the page itself as a redirect — that is not
 * http(s) or lands inside the network. `reason` is this package's own text, never page content.
 */
export class DesignUrlRefusedError extends UltimateError {
  constructor(input: { readonly url: string; readonly reason: string }) {
    super({
      code: 'X_DESIGN_URL_REFUSED',
      cause: `${renderCauseValue(input.url)} ${input.reason}: a reference is a public web page, and a headless browser pointed inside the network is an SSRF`,
      fix: 'x design research https://<public-host>/<path>   # a public http(s) page; private, loopback and link-local addresses are refused for every request the page makes',
      meta: { url: input.url },
    });
  }
}

/** The navigation failed or did not finish: a network error, a DNS miss, a 4xx/5xx, a timeout. */
export class DesignReferenceUnreachableError extends UltimateError {
  constructor(input: {
    readonly url: string;
    readonly reason: string;
    readonly timeoutMs: number;
  }) {
    super({
      code: 'X_DESIGN_REFERENCE_UNREACHABLE',
      cause: `${renderCauseValue(input.url)} could not be researched: ${input.reason}`,
      fix: `x design research ${renderFixShellArg(input.url, '<url>')} --timeout ${String(input.timeoutMs * 2)}   # or drop the URL from the list`,
      meta: { url: input.url, timeoutMs: input.timeoutMs },
    });
  }
}

/**
 * The caller went away (`ui.research` cancelled, the CLI interrupted). Core's `X_ABORTED`, as
 * `throwIfAborted` raises it: the run stops launching browsers and publishes nothing half-done.
 */
export class DesignAbortedError extends UltimateError {
  constructor(input: { readonly url: string }) {
    super({
      code: 'X_ABORTED',
      cause: `x design research was cancelled while researching ${renderCauseValue(input.url)}; nothing from that reference was published`,
      fix: `x design research ${renderFixShellArg(input.url, '<url>')} --json   # run it again when you still want it`,
      meta: { url: input.url },
    });
  }
}
