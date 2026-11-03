// One `fetch` call as `requestLog()` records it. A probe of the request is read, never the request:
// the handler and the real dial each still get a body of their own.

/** One dial, as attempted. A socket dial has no headers and no body. Unredacted, process-local. */
export interface LoggedRequest {
  readonly method: string;
  readonly url: string;
  /** Lowercase names. */
  readonly headers: Readonly<Record<string, string>>;
  /** Decoded as UTF-8. `null`: no body, an unreadable one, or a stream a real server is reading. */
  readonly body: string | null;
}

/** A stream read here would be drained ahead of its consumer, which is its backpressure gone. */
export const hasStreamBody = (init: RequestInit | undefined): boolean => {
  const body = init?.body ?? null;
  return !(
    body === null ||
    typeof body === 'string' ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof URLSearchParams
  );
};

/**
 * A body with no end the log can wait for: a stream, or a Request's own, which may be one. Its
 * capture runs beside the call, so a mock that answers 413 at once is not held to the stream's end.
 */
export const isOpenEnded = (input: RequestInfo | URL, init: RequestInit | undefined): boolean =>
  hasStreamBody(init) || (init?.body == null && input instanceof Request && input.body !== null);

/**
 * The call's own request, for reading only: a stream body stays out of it, unlocked. `undefined`
 * when no Request can hold the call, so the refusal the test is owed stays the seal's or the real
 * dial's rather than this module's `TypeError`.
 */
export const requestProbe = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Request | undefined => {
  try {
    if (input instanceof Request && init === undefined) return input.clone();
    const source = input instanceof Request ? input.clone() : input;
    return new Request(source, hasStreamBody(init) ? { ...init, body: null } : init);
  } catch {
    return undefined;
  }
};

export const headersOf = (probe: Request | undefined): Readonly<Record<string, string>> =>
  probe === undefined ? {} : Object.fromEntries(probe.headers);

/** Never rejects: a body that cannot be read is the real call's failure to report, not the log's. */
export const readBody = async (request: Request | undefined): Promise<string | null> => {
  if (request === undefined) return null;
  try {
    return request.body === null ? null : await request.text();
  } catch {
    return null;
  }
};
