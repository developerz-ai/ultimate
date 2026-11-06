// The fixed half of every customer client's `index.ts`: options, the problem error and the one
// sender each operation calls. Platform only — no import — and the same bytes in every client, so
// what a customer reviews once is what every regeneration ships.

export const CUSTOMER_RUNTIME = `/** Where the API lives, and how each request is authorised. */
export interface ClientOptions {
  /** \`https://api.example.com\` — every operation's path is appended to it. */
  readonly baseUrl: string;
  /** Called before every request: the token or session the caller holds is the caller's to keep. */
  readonly headers?:
    | (() => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>)
    | undefined;
  /** The transport; the platform \`fetch\` when omitted. */
  readonly fetch?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
}

export interface CallOptions {
  readonly signal?: AbortSignal | undefined;
}

/** An RFC 9457 problem body, as the API answers a refusal. */
export interface Problem {
  readonly type?: string | undefined;
  readonly title?: string | undefined;
  readonly status?: number | undefined;
  readonly code?: string | undefined;
  readonly detail?: string | undefined;
  readonly cause?: string | undefined;
  readonly fix?: string | undefined;
  readonly requestId?: string | undefined;
}

/** A non-2xx answer: which operation, the status, and the problem body when there was one. */
export class ProblemError extends Error {
  readonly operation: string;
  readonly status: number;
  readonly code: string | undefined;
  readonly problem: Problem | undefined;

  constructor(operation: string, status: number, problem: Problem | undefined) {
    const code = problem?.code ?? /^urn:ultimate:error:(X_[A-Z0-9_]+)$/.exec(problem?.type ?? '')?.[1];
    super(\`\${operation} answered \${String(status)}\${code === undefined ? '' : \` \${code}\`}\`);
    this.name = 'ProblemError';
    this.operation = operation;
    this.status = status;
    this.code = code;
    this.problem = problem;
  }
}

interface CallSpec {
  readonly operation: string;
  readonly method: string;
  readonly path: string;
  readonly pathParams: readonly string[];
  readonly query: readonly string[];
  readonly headers: readonly string[];
  /** \`value\`: \`input.body\` is the body; a list: those input fields are. */
  readonly body: 'none' | 'value' | readonly string[];
  readonly empty: boolean;
}

/** The longest \`Retry-After\` waited out; a longer one is the caller's to schedule. */
const RETRY_AFTER_MAX_MS = 60_000;

const read = (input: object, key: string): unknown =>
  Object.hasOwn(input, key) ? (input as Readonly<Record<string, unknown>>)[key] : undefined;

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  const ms = raw.trim() !== '' && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  return Number.isFinite(ms) && ms >= 0 && ms <= RETRY_AFTER_MAX_MS ? ms : undefined;
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

async function problemOf(response: Response): Promise<Problem | undefined> {
  try {
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null ? (body as Problem) : undefined;
  } catch {
    // Not JSON: the status alone is the answer, and the error says so with no problem body.
    return undefined;
  }
}

function sender(options: ClientOptions) {
  const transport =
    options.fetch ?? ((url: string, init: RequestInit) => fetch(url, { ...init, signal: init.signal ?? null }));
  return async (spec: CallSpec, input: object, call: CallOptions): Promise<unknown> => {
    let path = spec.path;
    for (const name of spec.pathParams) {
      path = path.replace(\`{\${name}}\`, encodeURIComponent(String(read(input, name))));
    }
    const url = new URL(\`\${options.baseUrl.replace(/\\/$/, '')}\${path}\`);
    for (const name of spec.query) {
      const value = read(input, name);
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, String(item));
    }
    const headers: Record<string, string> = { accept: 'application/json', ...(await options.headers?.()) };
    for (const name of spec.headers) {
      const value = read(input, name);
      if (value !== undefined) headers[name] = String(value);
    }
    let body: string | null = null;
    if (spec.body === 'value') body = JSON.stringify(read(input, 'body'));
    else if (typeof spec.body !== 'string') {
      const fields = spec.body.filter((key) => read(input, key) !== undefined);
      body = JSON.stringify(Object.fromEntries(fields.map((key) => [key, read(input, key)])));
    }
    if (body !== null) headers['content-type'] = 'application/json';
    for (let attempt = 0; ; attempt += 1) {
      const response = await transport(url.toString(), { method: spec.method, headers, body, signal: call.signal ?? null });
      if (response.ok) return spec.empty || response.status === 204 ? undefined : await response.json();
      // A 429 or 503 with a Retry-After is waited out once; a second refusal is the caller's.
      const delay = attempt === 0 && (response.status === 429 || response.status === 503) ? retryAfterMs(response) : undefined;
      if (delay === undefined) throw new ProblemError(spec.operation, response.status, await problemOf(response));
      await response.body?.cancel();
      await wait(delay, call.signal);
    }
  };
}
`;
