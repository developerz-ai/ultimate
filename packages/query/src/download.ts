/**
 * `query({ input, policy, download })` — a read whose answer is a FILE, served at a short-lived
 * signed URL. Still a `query`: the same input parse, the same policy, the same declared limit, the
 * same audit, one name in the registry and the manifest. Only the answer differs, so the rows
 * projections (`live`, `page`, `as`, MCP, `explain`) are refused by the `sql` this file stores.
 *
 * Two calls make a download. `url(input)` runs the read's front half as the caller and seals a
 * token naming the caller, the input and an expiry. `GET <url>` opens the token, re-parses the
 * input from the URL and runs `handle` as the minting actor — the policy decided at mint, and the
 * token is what it decided. That is what lets a `<video src>` or a link handed to someone without
 * the session's headers fetch the bytes, and what keeps a URL from outliving `expiresInMs`.
 */

import type { Ctx, Deprecation } from '@ultimat3/core';
import { queryPath, useContext } from '@ultimat3/core';
import type { InferInput, InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type { DownloadUrl, QueryCallOptions, QueryClientOptions } from './client';
import { downloadClientFor } from './client';
import { QueryDownloadInvalidError, QueryDownloadOnlyError } from './download-errors';
import {
  assertGrantedInput,
  DOWNLOAD_GRANT_PARAM,
  mintDownloadToken,
  openDownloadToken,
} from './download-token';
import type { QueryPolicy } from './policy-gate';
import type { AnyQuery, AnyQueryDef, QueryDescriptor, QueryOptions, QueryRateLimit } from './query';
import { admittedCall, defOf, queryName, stashDef } from './read';
import { searchOf } from './search-string';

export type { DownloadUrl } from './client';

/** How long a minted URL works when the declaration names nothing: long enough to start a player. */
export const DEFAULT_DOWNLOAD_TTL_MS = 300_000;
/** The floor and ceiling of `expiresInMs`. A URL is a bearer capability; an hour is the most. */
export const MIN_DOWNLOAD_TTL_MS = 1_000;
export const MAX_DOWNLOAD_TTL_MS = 3_600_000;

/** The written reason the token's serve skips the policy — `admit`'s escape, never a boolean. */
const TOKEN_IS_THE_GRANT =
  'a download token is sealed only by url(), after this query admitted the minting actor; the token is that decision';

/** What `handle` answers. Bytes, never a base64 string — that is the +33 % this exists to remove. */
export interface DownloadFile {
  /**
   * A `Uint8Array` or a `Blob` (a `Bun.file`, a slice) is range-served from its own length; a
   * `ReadableStream` is range-served only with `size`, else whole with `accept-ranges: none`.
   */
  readonly body: Uint8Array | Blob | ReadableStream<Uint8Array>;
  readonly contentType: string;
  /** The name a browser saves it under — `content-disposition`'s `filename` and `filename*`. */
  readonly filename: string;
  /** `attachment` (default) saves it; `inline` lets a tab render it. `<video>` ignores both. */
  readonly disposition?: 'attachment' | 'inline' | undefined;
  /** The stream's length in bytes. Ignored for a `Uint8Array` or a `Blob`, which know theirs. */
  readonly size?: number | undefined;
}

export interface DownloadArgs<TInput extends StandardSchemaV1> {
  readonly input: InferOutput<TInput>;
  readonly ctx: Ctx;
}

export interface QueryDownload<TInput extends StandardSchemaV1> {
  /** How long a minted URL works: 1 000 … 3 600 000 ms. Default `DEFAULT_DOWNLOAD_TTL_MS` (5 min). */
  readonly expiresInMs?: number | undefined;
  /**
   * The file, for an input the policy already admitted. Runs as the actor that MINTED the URL;
   * decrypt a sealed object here (`open()` from `@ultimat3/core`) — an AES-GCM envelope opens whole,
   * so a sealed object is buffered, bounded by its disk's `maxGetBytes`.
   */
  handle(args: DownloadArgs<TInput>): Promise<DownloadFile>;
}

type RowsOnly = 'sql' | 'live' | 'single' | 'subscribes' | 'rows' | 'cache' | 'mcp';

/** A download declares no rows option: each is a type error here and `X_QUERY_DOWNLOAD_INVALID` at runtime. */
export type DownloadQueryDef<TInput extends StandardSchemaV1> = {
  readonly input: TInput;
  readonly policy: QueryPolicy;
  readonly download: QueryDownload<TInput>;
  /** Spent at MINT — one URL is one admitted read, however many `Range:` requests a player makes. */
  readonly rateLimit?: QueryRateLimit;
  readonly deprecated?: Deprecation;
  /** Records the MINT: the decision of who may read what. A ranged GET is not a second read. */
  readonly audit?: boolean;
} & { readonly [K in RowsOnly]?: never };

/** `client.recording.url(input)` — the browser half: the server mints, this prefixes the base. */
export interface DownloadClientMethod<TInput extends StandardSchemaV1> {
  url(input: InferInput<TInput>, options?: QueryCallOptions): Promise<DownloadUrl>;
}

export interface DownloadQuery<TInput extends StandardSchemaV1 = StandardSchemaV1>
  extends AnyQuery {
  /** The file, in-process: the same parse and policy as `url()`, then `handle` as this caller. */
  (input: InferInput<TInput>, options?: QueryOptions): Promise<DownloadFile>;
  readonly input: TInput;
  readonly download: true;
  /** Mint a signed URL — a PATH, `/_x/query/<kebab>?…&_token=…` — for this caller and this input. */
  url(input: InferInput<TInput>, options?: QueryOptions): Promise<DownloadUrl>;
  client(options: QueryClientOptions): DownloadClientMethod<TInput>;
  named(name: string): DownloadQuery<TInput>;
}

const isFunction = (value: unknown): value is (...args: never[]) => unknown =>
  typeof value === 'function';

/** The declaration, judged where it is written: an untyped caller can still pass `sql` beside it. */
export function assertDownloadDef(def: Readonly<Record<string, unknown>>): void {
  const download = def['download'];
  if (typeof download !== 'object' || download === null) {
    throw new QueryDownloadInvalidError('download is not an object with a handle');
  }
  const rows = (['sql', 'live', 'single', 'subscribes', 'rows', 'cache', 'mcp'] as const).filter(
    (key) => def[key] !== undefined,
  );
  if (rows.length > 0) {
    throw new QueryDownloadInvalidError(`it also declares ${rows.join(', ')}, which answer rows`);
  }
  if (!isFunction(Reflect.get(download, 'handle'))) {
    throw new QueryDownloadInvalidError('download.handle is not a function');
  }
  const ttl: unknown = Reflect.get(download, 'expiresInMs');
  const whole = typeof ttl === 'number' && Number.isSafeInteger(ttl);
  if (ttl !== undefined && !(whole && ttl >= MIN_DOWNLOAD_TTL_MS && ttl <= MAX_DOWNLOAD_TTL_MS)) {
    throw new QueryDownloadInvalidError(
      `download.expiresInMs is ${String(ttl)}, not a whole number of ms from ${MIN_DOWNLOAD_TTL_MS} to ${MAX_DOWNLOAD_TTL_MS}`,
    );
  }
}

/** `describe` is handed in, so this file never value-imports `query.ts` (which imports it). */
export function buildDownloadQuery<TInput extends StandardSchemaV1>(
  def: DownloadQueryDef<TInput>,
  name: string,
  describe: (target: AnyQuery) => QueryDescriptor,
): DownloadQuery<TInput> {
  const refuse = (): Promise<never> => Promise.reject(new QueryDownloadOnlyError(queryName(self)));
  const callable = (input: InferInput<TInput>, options: QueryOptions = {}): Promise<DownloadFile> =>
    readDownloadFile(self, input, options);
  const self: DownloadQuery<TInput> = Object.assign(callable, {
    kind: 'query' as const,
    isLive: false,
    download: true as const,
    input: def.input,
    policy: def.policy,
    ...(def.rateLimit === undefined ? {} : { rateLimit: def.rateLimit }),
    ...(def.deprecated === undefined ? {} : { deprecated: def.deprecated }),
    describe: (): QueryDescriptor => describe(self),
    named: (next: string): DownloadQuery<TInput> => buildDownloadQuery(def, next, describe),
    as: refuse,
    page: refuse,
    live: refuse,
    url: (input: InferInput<TInput>, options: QueryOptions = {}) =>
      mintDownloadUrl(self, input, options),
    client: (options: QueryClientOptions): DownloadClientMethod<TInput> => ({
      url: downloadClientFor<TInput>(queryName(self), options).url,
    }),
  });
  Object.defineProperty(self, 'name', { value: name, configurable: true });
  const stored: AnyQueryDef = {
    input: def.input,
    policy: def.policy,
    ...(def.rateLimit === undefined ? {} : { rateLimit: def.rateLimit }),
    ...(def.deprecated === undefined ? {} : { deprecated: def.deprecated }),
    ...(def.audit === undefined ? {} : { audit: def.audit }),
    download: def.download,
    // Every rows projection ends here — one refusal, wherever the rows were asked from.
    sql: () => {
      throw new QueryDownloadOnlyError(queryName(self));
    },
  };
  stashDef(self, stored);
  return self;
}

function handlerOf(target: AnyQuery): QueryDownload<StandardSchemaV1> {
  const download = defOf(target).download;
  if (download === undefined) throw new QueryDownloadOnlyError(queryName(target));
  return download;
}

/** The in-process read: admitted as the caller, answered by `handle`. */
export function readDownloadFile(
  target: AnyQuery,
  raw: unknown,
  options: QueryOptions,
): Promise<DownloadFile> {
  const download = handlerOf(target);
  return admittedCall(target, raw, options, (input, ctx) => download.handle({ input, ctx }));
}

/**
 * Admit the caller exactly as a read would, then seal the decision. The URL carries the input as
 * it was HANDED in (the route re-parses it to the same value) and the token binds the PARSED one.
 */
export function mintDownloadUrl(
  target: AnyQuery,
  raw: unknown,
  options: QueryOptions,
): Promise<DownloadUrl> {
  const name = queryName(target);
  const ttl = handlerOf(target).expiresInMs ?? DEFAULT_DOWNLOAD_TTL_MS;
  return admittedCall(target, raw, options, async (input, ctx) => {
    const expiresAtMs = ctx.now().getTime() + ttl;
    const token = await mintDownloadToken(name, input, ctx.actor, expiresAtMs);
    const search = searchOf(raw);
    const tokenParam = `${DOWNLOAD_GRANT_PARAM}=${encodeURIComponent(token)}`;
    return {
      url: `${queryPath(name)}?${search === '' ? '' : `${search}&`}${tokenParam}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  });
}

/**
 * The file a token grants: the token opened against THIS query and THIS input on the context's
 * clock, then `handle` as the minting actor. The input is still parsed — `handle` is owed the
 * schema's output — and the policy is not re-run: it ran at mint, with facts this token cannot
 * carry, and the written reason above is what `admit` logs for the skip.
 */
export async function serveDownloadFile(
  target: AnyQuery,
  raw: unknown,
  token: string,
  options: QueryOptions,
): Promise<DownloadFile> {
  const name = queryName(target);
  const download = handlerOf(target);
  const now = (options.ctx ?? useContext()).now().getTime();
  const grant = await openDownloadToken(name, token, now);
  return admittedCall(
    target,
    raw,
    { ...options, actor: grant.actor, unenforced: TOKEN_IS_THE_GRANT },
    (input, ctx) => {
      assertGrantedInput(name, grant, input);
      return download.handle({ input, ctx });
    },
  );
}
