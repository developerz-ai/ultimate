// Every RENDERING of a throwable the framework has: the normalised facts, the RFC-9457 problem
// document and the three lines the terminal and the overlay print. Split off `error-map.ts` at the
// 500-line ceiling — that file answers "what status is this code", one closed table, and this one
// answers "what does a reader see", which is three audiences and one opacity rule.
import { ERROR_DOCS_URL, renderCauseValue, singleLine, stringField } from '@ultimat3/core';
import { declaredStatusFor, statusFor } from './error-map';
import { HTTP_ERROR_TITLES } from './errors';

/** Everything a renderer (problem+json, overlay, terminal) needs from a throwable. */
export interface ErrorFacts {
  readonly code: string;
  readonly title: string;
  readonly cause: string;
  readonly fix: string;
  readonly docs: string;
  readonly status: number;
  /** Present only when the process is in dev mode; never sent to a client in prod. */
  readonly stack: string | undefined;
}

/**
 * One string field off the throwable, through core's `stringField`. The read is a getter call —
 * or a `Proxy`'s `get` trap — on a value the framework did not build, and it throws in the one
 * place with nothing left to answer with: `factsOf` is called by the RECOVER stage, and again by
 * the `problem()` that `recoverWith` degrades to, so a value that refuses to be read took both
 * renderings and `handle()` rejected against its own contract.
 */
const str = (source: unknown, key: string): string | undefined => {
  const value = stringField(source, key);
  return value !== undefined && value.length > 0 ? value : undefined;
};

/**
 * Normalises any throwable into the framework's error contract. Non-Ultimate
 * throwables still get a code and a fix, because "errors are instructions" has to
 * hold for the accidental `TypeError` too.
 */
export const factsOf = (error: unknown): ErrorFacts => {
  const code = str(error, 'code') ?? 'X_INTERNAL';
  // The error's own title first: every `UltimateError` resolves one from the code registry at
  // construction, so this renders the OWNING package's title — including the codes http only
  // borrows (`X_FORBIDDEN` is policy's, `X_UNAUTHENTICATED` is auth's) and so cannot title itself.
  // Falling through to `message` here shipped the code twice: `X_FORBIDDEN: policy denied… — …`.
  const title =
    str(error, 'title') ??
    // `Object.hasOwn` for `statusFor`'s reason, one table over: `code: 'toString'` read the
    // function off the prototype and put it in `title`, which is rendered into the problem
    // document and the terminal.
    (Object.hasOwn(HTTP_ERROR_TITLES, code)
      ? HTTP_ERROR_TITLES[code as keyof typeof HTTP_ERROR_TITLES]
      : undefined) ??
    str(error, 'message') ??
    'unhandled server error';
  // The last fallback is the only one that touches the throwable whole, and every throwable a
  // request produces reaches it. `String()` runs the value's own `toString`, so the value that
  // took the request down took the 500 renderer with it and the server had nothing left to send.
  const cause = str(error, 'cause') ?? str(error, 'message') ?? renderCauseValue(error);
  return {
    code,
    title,
    cause,
    // `x logs tail` is in `PLANNED_COMMANDS` — it exits `X_NOT_IMPLEMENTED`. A fix line naming a
    // command that throws is axiom 4 inverted: the one instruction the reader is given fails.
    // `x errors explain` ships, and it is the command that answers "what is this code".
    fix: str(error, 'fix') ?? `x errors explain ${code} --json   # then fix the throwing call site`,
    // Core's one constant, never a per-code URL: `wiki/` is the only public documentation surface
    // and a code lives there in a table row, which has no anchor. An `UltimateError` already
    // resolved this at construction, so the fallback only fires for a throwable the framework did
    // not build — and it must not be the `https://ultimate.dev/errors/<code>` link that answered
    // 404 on every problem document this package has ever rendered.
    docs: str(error, 'docs') ?? ERROR_DOCS_URL,
    status: statusFor(code),
    stack: str(error, 'stack'),
  };
};

/**
 * `Retry-After`, in whole seconds, for a refusal that computed one — or `undefined`.
 *
 * The contract it reads is already written down by the packages BELOW this one: `@ultimat3/auth`'s
 * `kdfOverloaded` says "`retryAfterSeconds` rides in `meta` because this package cannot reach an
 * HTTP header; the host reads it onto `Retry-After`", and `rateLimited` in this package carries the
 * same field. Nothing was the host. So a 503 shed by the KDF gate and a 429 from an account lockout
 * both told the caller to come back and never said when — which is the shed-with-no-delay pattern
 * the `admit` stage exists to avoid, one layer in.
 *
 * Total, for `str`'s reason one function up: `meta` is a property read on a value this package did
 * not build, and it is read in the frame that decides what the caller sees.
 */
export function retryAfterOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  try {
    const meta: unknown = (error as Record<string, unknown>)['meta'];
    if (typeof meta !== 'object' || meta === null) return undefined;
    const seconds: unknown = (meta as Record<string, unknown>)['retryAfterSeconds'];
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return undefined;
    // At least one second, exactly as `RateLimitDecision.retryAfterSeconds` is clamped: `0` reads
    // as "retry now", which is the stampede a Retry-After exists to spread.
    return Math.max(1, Math.ceil(seconds));
  } catch {
    return undefined;
  }
}

/**
 * RFC-9457 `type`, per code. A URN, and deliberately not a URL: `type` is the document's PRIMARY
 * identifier for the problem KIND — a client switches on it — while `docs` is where a human goes
 * to read about it, and those stopped being the same string when `docs` became one wiki page for
 * every code. Collapsing `type` onto that page too would have given a 422 body-invalid and a 403
 * forbidden the same identifier, which is the one thing a `type` may not do.
 *
 * A URN has no host to resolve, so it cannot rot the way `https://ultimate.dev/errors/<code>` did
 * — it was never dereferenceable and never claimed to be, which RFC 9457 §3.1.1 explicitly allows.
 * `code` carries the same string as a plain member for a reader that would rather not parse a URI.
 */
export const problemTypeFor = (code: string): string => `urn:ultimate:error:${singleLine(code)}`;

/** RFC-9457 problem document. `code`/`cause`/`fix`/`docs` are our extensions. */
export interface ProblemDocument {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string | undefined;
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
  readonly docs: string;
  readonly requestId: string | undefined;
}

/** The title a caller gets for a failure the framework cannot name. */
const INTERNAL_TITLE = 'unhandled server error';

/**
 * The cause a caller gets for one. An unclassified 5xx has no `cause` of its own, so `factsOf`
 * falls through to the throwable's `message` — a driver's DSN, the row Postgres rejected, an
 * absolute path — and `toProblem` handed it to whoever asked. `error-page.ts` locked the BROWSER
 * out of exactly this and said so in its header; the two audiences then disagreed about one
 * condition. The real text is not lost: the `error-map` stage logs it as a redactable FIELD and
 * reports every 5xx to the error monitor, both keyed by the request id below.
 */
const INTERNAL_CAUSE =
  'the server failed while handling this request; the details are in this process\u2019s logs and ' +
  'error reports, under this request id';

/**
 * A 5xx nobody declared a status for — not the framework's table, not the app's
 * `registerErrorStatus` — or one whose code is `X_INTERNAL`. That is the discriminator, and not
 * `status >= 500` alone: a declared code has an authored cause, and blanking `X_DRAINING`'s would
 * take away the one instruction in it.
 *
 * `X_INTERNAL` is in the framework's table and still belongs here, because it is the framework's
 * own word for "nobody classified this": `factsOf` mints it for a throwable carrying no code, and
 * core's `toError()` wraps a caught value into an `InternalError` whose cause is
 * `renderCauseValue(value)` — the driver's message, verbatim. Nothing in an `X_INTERNAL` is
 * actionable by the caller; the code and the request id are.
 */
const isUnclassifiedFailure = (code: string, status: number): boolean =>
  status >= 500 && (code === 'X_INTERNAL' || declaredStatusFor(code) === undefined);

export const toProblem = (
  error: unknown,
  meta: { instance?: string; requestId?: string; dev?: boolean } = {},
): ProblemDocument => {
  const facts = factsOf(error);
  const opaque = meta.dev !== true && isUnclassifiedFailure(facts.code, facts.status);
  return {
    type: problemTypeFor(facts.code),
    title: opaque ? INTERNAL_TITLE : facts.title,
    status: facts.status,
    detail: opaque ? INTERNAL_CAUSE : facts.cause,
    instance: meta.instance,
    code: facts.code,
    cause: opaque ? INTERNAL_CAUSE : facts.cause,
    fix: facts.fix,
    docs: facts.docs,
    requestId: meta.requestId,
  };
};

/** The exact three lines the terminal prints, reused by the overlay and `--json`. */
export const renderErrorLines = (error: unknown): string => {
  const facts = factsOf(error);
  // The newlines here are the format's own. Every interpolated field goes through `singleLine`
  // so a caller-controlled value cannot add a third one — this string is rendered into the dev
  // overlay's `<pre>`, where HTML escaping does not help because a newline is not markup.
  return [
    `${singleLine(facts.code)}: ${singleLine(facts.title)}`,
    `  cause: ${singleLine(facts.cause)}`,
    `  fix:   ${singleLine(facts.fix)}`,
  ].join('\n');
};
