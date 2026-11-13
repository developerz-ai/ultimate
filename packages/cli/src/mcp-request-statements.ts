// `requests.statements`: the running `x dev`'s per-request statement counts and N+1 verdicts, read
// off its own `/_x/timeline` JSON — the panel that already projects the recorder and the ledger
// (`dev-n-plus-one.ts`). The ledger lives in that process, so this asks it; it never keeps a copy.

import { renderThrowable, UltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';

/** What one timeline answer is parsed into: only the fields this tool reports. */
const SPAN = t.object({ kind: t.string });
const TRACE = t.object({
  requestId: t.string,
  method: t.string,
  path: t.string,
  status: t.number,
  spans: t.array(SPAN),
});
const TIMELINE = t.object({
  requests: t.array(t.object({ requestId: t.string, path: t.string, totalMs: t.number })),
  selected: t.nullable(TRACE),
  repeatedSql: t.array(t.object({ sql: t.string, count: t.number })),
  nPlusOne: t.nullable(t.array(t.json())),
});
const PAYLOAD = t.object({
  ok: t.boolean,
  data: t.optional(t.json()),
  error: t.optional(t.object({ code: t.string, cause: t.string, fix: t.string })),
});

/** One GET of the dev server, answered as parsed JSON. A seam so a test needs no server. */
export type FetchJson = (url: string) => Promise<unknown>;

const restart = 'x stop --json && x dev   # the running x dev did not answer as this CLI expects';

export const fetchJson: FetchJson = async (url) => {
  try {
    return (await (
      await fetch(url, {
        headers: { accept: 'application/json' },
        // A local dev server answers in milliseconds; a wedged one must not hold the tool.
        signal: AbortSignal.timeout(5_000),
      })
    ).json()) as unknown;
  } catch (error) {
    throw new UltimateError({
      code: 'X_CLI_UNEXPECTED',
      cause: `requests.statements could not read ${url}: ${renderThrowable(error)}`,
      fix: restart,
    });
  }
};

interface Timeline {
  readonly requests: readonly { readonly requestId: string }[];
  readonly selected: {
    readonly requestId: string;
    readonly method: string;
    readonly path: string;
    readonly status: number;
    readonly spans: readonly { readonly kind: string }[];
  } | null;
  readonly repeatedSql: readonly { readonly sql: string; readonly count: number }[];
  readonly nPlusOne: readonly unknown[] | null;
}

/** One panel read: the panel's own refusal passes through with its code, cause and fix. */
async function timeline(get: FetchJson, base: string, requestId?: string): Promise<Timeline> {
  const query = requestId === undefined ? '' : `&requestId=${encodeURIComponent(requestId)}`;
  const url = `${base}/_x/timeline?json=1${query}`;
  const payload = PAYLOAD.safeParse(await get(url));
  if (payload.issues !== undefined) {
    throw new UltimateError({
      code: 'X_CLI_UNEXPECTED',
      cause: `requests.statements read ${url} and it is not a /_x panel answer`,
      fix: restart,
    });
  }
  const { ok, data, error } = payload.value;
  if (!ok && error !== undefined) throw new UltimateError(error);
  const parsed = TIMELINE.safeParse(data);
  if (parsed.issues !== undefined) {
    throw new UltimateError({
      code: 'X_CLI_UNEXPECTED',
      cause: `requests.statements read ${url} and its timeline is not the shape this CLI reads`,
      fix: restart,
    });
  }
  return parsed.value;
}

/** The selected request, as the tool reports it — `null` verdicts mean no ledger, not no loops. */
function requestFacts(view: Timeline): unknown {
  const selected = view.selected;
  if (selected === null) return null;
  return {
    requestId: selected.requestId,
    method: selected.method,
    path: selected.path,
    status: selected.status,
    statements: selected.spans.filter((span) => span.kind === 'sql').length,
    repeated: view.repeatedSql,
    nPlusOne: view.nPlusOne,
  };
}

/**
 * `requestId` given: that request. Absent: the newest `limit`, newest first — one panel read per
 * request, because the panel counts statements for the request it is asked about and no other.
 */
export async function requestStatements(
  input: {
    readonly devUrl: string;
    readonly requestId: string | undefined;
    readonly limit: number;
  },
  get: FetchJson = fetchJson,
): Promise<unknown> {
  const first = await timeline(get, input.devUrl, input.requestId);
  if (input.requestId !== undefined) {
    const found = first.selected?.requestId === input.requestId ? [requestFacts(first)] : [];
    // A request the recorder no longer holds answers the ones it does, never a bare empty list.
    return found.length > 0
      ? { devUrl: input.devUrl, requests: found }
      : { devUrl: input.devUrl, requests: [], known: first.requests.map((r) => r.requestId) };
  }
  const rest = first.requests.slice(1, input.limit).map((request) => request.requestId);
  const others = await Promise.all(rest.map((id) => timeline(get, input.devUrl, id)));
  const requests = [first, ...others].map(requestFacts).filter((request) => request !== null);
  return { devUrl: input.devUrl, requests };
}
