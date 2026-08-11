// The one place a framework error code becomes an HTTP status. A table, not a
// switch chain: adding a code elsewhere in the framework means adding a row here,
// and a missing row is a loud 500 rather than a silently wrong 200.
import { HTTP_ERROR_TITLES } from './errors';

/**
 * code -> status. Codes owned by other packages are listed here on purpose: HTTP
 * is the only layer that knows what a status means, so no other package should
 * ever hardcode one.
 */
export const ERROR_STATUS: Readonly<Record<string, number>> = {
  // @ultimat3/http
  X_ROUTE_NOT_FOUND: 404,
  X_METHOD_NOT_ALLOWED: 405,
  X_BODY_INVALID: 422,
  X_UNAUTHENTICATED: 401,
  X_FORBIDDEN: 403,
  X_RATE_LIMITED: 429,
  X_BUILD_SKEW: 409,
  X_ROUTE_CONFLICT: 500,
  X_SERVER_NOT_STARTED: 500,
  X_PIPELINE_NO_RESPONSE: 500,
  // @ultimat3/entity
  X_NOT_FOUND: 404,
  X_ENTITY_DUPLICATE: 409,
  X_INVARIANT_VIOLATED: 422,
  X_TENANCY_UNSCOPED: 500,
  X_DB_DRIFT: 500,
  // @ultimat3/policy
  X_POLICY_MISSING: 500,
  X_PERMISSION_UNKNOWN: 500,
  // @ultimat3/seo — a transform query the caller wrote, so the caller is the one who can fix it.
  X_IMAGE_QUERY_INVALID: 400,
  // @ultimat3/storage — every one of these is reachable from a route: `/media/*` already serves
  // objects, and a mounted `/_storage` serves signed reads and takes signed writes. Without a row
  // a missing image answers 500, which reads as an outage instead of a 404.
  X_STORAGE_NOT_FOUND: 404,
  X_STORAGE_PATH_UNSAFE: 400,
  X_STORAGE_TOO_LARGE: 413,
  X_STORAGE_TYPE_REJECTED: 415,
  X_STORAGE_CHECKSUM_MISMATCH: 422,
  X_STORAGE_URL_INVALID: 403,
  X_STORAGE_URL_EXPIRED: 410,
  // 404, deliberately NOT 403: the org check fires before anything is read, so answering
  // "forbidden" would confirm that a key exists to the one caller who must not learn it.
  X_STORAGE_ORG_MISMATCH: 404,
  // @ultimat3/core
  // The caller asked for a format the pipeline cannot produce (`?f=avif`): the request names an
  // unsupported representation, which is 415 — not a 500, which would blame the server for it.
  X_IMAGE_UNSUPPORTED: 415,
  X_NOT_IMPLEMENTED: 501,
  X_TIMEOUT: 504,
  X_ABORTED: 499,
  X_INTERNAL: 500,
};

export const DEFAULT_STATUS = 500;

export const statusFor = (code: string): number => ERROR_STATUS[code] ?? DEFAULT_STATUS;

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

const str = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/**
 * Normalises any throwable into the framework's error contract. Non-Ultimate
 * throwables still get a code and a fix, because "errors are instructions" has to
 * hold for the accidental `TypeError` too.
 */
export const factsOf = (error: unknown): ErrorFacts => {
  const record = asRecord(error);
  const code = str(record, 'code') ?? 'X_INTERNAL';
  // The error's own title first: every `UltimateError` resolves one from the code registry at
  // construction, so this renders the OWNING package's title — including the codes http only
  // borrows (`X_FORBIDDEN` is policy's, `X_UNAUTHENTICATED` is auth's) and so cannot title itself.
  // Falling through to `message` here shipped the code twice: `X_FORBIDDEN: policy denied… — …`.
  const title =
    str(record, 'title') ??
    HTTP_ERROR_TITLES[code as keyof typeof HTTP_ERROR_TITLES] ??
    str(record, 'message') ??
    'unhandled server error';
  const cause = str(record, 'cause') ?? str(record, 'message') ?? String(error);
  return {
    code,
    title,
    cause,
    fix: str(record, 'fix') ?? 'x logs tail --json   # then fix the throwing call site',
    docs: str(record, 'docs') ?? `https://ultimate.dev/errors/${code}`,
    status: statusFor(code),
    stack: str(record, 'stack'),
  };
};

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

export const toProblem = (
  error: unknown,
  meta: { instance?: string; requestId?: string } = {},
): ProblemDocument => {
  const facts = factsOf(error);
  return {
    type: facts.docs,
    title: facts.title,
    status: facts.status,
    detail: facts.cause,
    instance: meta.instance,
    code: facts.code,
    cause: facts.cause,
    fix: facts.fix,
    docs: facts.docs,
    requestId: meta.requestId,
  };
};

/** The exact three lines the terminal prints, reused by the overlay and `--json`. */
export const renderErrorLines = (error: unknown): string => {
  const facts = factsOf(error);
  return `${facts.code}: ${facts.title}\n  cause: ${facts.cause}\n  fix:   ${facts.fix}`;
};
