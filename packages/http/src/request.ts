// The typed request. Handlers never touch the raw `Request`: params, query and body
// only exist here in validated form, and actor/locale/tz are read from the request
// context so they cannot drift from what the pipeline resolved.

import type { Actor } from '@ultimat3/core';
import type { RequestContext } from './context';
import { bodyInvalid, buildSkew } from './errors';
import { readCookie } from './locale';
import type { Schema } from './validate';
import { validate, validateSync } from './validate';

export type QueryValues = Readonly<Record<string, string | readonly string[]>>;

const contentTypeOf = (request: Request): string =>
  (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

/** Repeated keys become arrays; everything else stays a string for the schema to coerce. */
const parseQuery = (url: URL): QueryValues => {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams) {
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
};

/** What a body read produced: the bytes, or the running total at the moment it went over. */
type CappedBody = { readonly bytes: Uint8Array } | { readonly over: number };

/**
 * The body, read through the stream and abandoned the instant the running total passes `limit`.
 * `arrayBuffer()` materialises first and checks after, so a `transfer-encoding: chunked` request —
 * one with no `content-length` for the pre-check to read — allocated its whole payload before the
 * 413 it was going to get anyway. A declared length is a courtesy, not a guard.
 */
const readWithinLimit = async (
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<CappedBody> => {
  if (body === null) return { bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        // Cancelled rather than drained: the peer is told to stop sending, and nothing past the
        // cap is ever held. Draining is how a rejected request still costs its full transfer.
        await reader.cancel();
        return { over: total };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
};

export class UltimateRequest {
  readonly raw: Request;
  readonly ctx: RequestContext;
  #body: { parsed: unknown } | undefined;

  constructor(raw: Request, ctx: RequestContext) {
    this.raw = raw;
    this.ctx = ctx;
  }

  get method(): string {
    return this.ctx.method;
  }

  get url(): URL {
    return this.ctx.url;
  }

  get pathname(): string {
    return this.ctx.url.pathname;
  }

  get headers(): Headers {
    return this.raw.headers;
  }

  get params(): Readonly<Record<string, string>> {
    return this.ctx.params;
  }

  /** Never null — an unauthenticated call carries core's anonymous actor, same as `Ctx`. */
  get actor(): Actor {
    return this.ctx.actor;
  }

  get locale(): string {
    return this.ctx.locale;
  }

  get tz(): string {
    return this.ctx.tz;
  }

  get requestId(): string {
    return this.ctx.requestId;
  }

  /** Build id the client thinks it is running. See `assertBuild()`. */
  get buildId(): string | null {
    return this.ctx.buildId;
  }

  header(name: string): string | null {
    return this.raw.headers.get(name);
  }

  /**
   * One decoded cookie. `hooks.authenticate` is handed this object and nothing else, so this is
   * the seam a session lookup reads — a hand-rolled `Cookie` split in the app is the second
   * parser this method exists to prevent.
   */
  cookie(name: string): string | null {
    return readCookie(this.raw.headers.get('cookie'), name);
  }

  param(name: string): string {
    const value = this.ctx.params[name];
    if (value === undefined) {
      throw bodyInvalid(this.pathname, [`no :${name} segment in the matched route path`]);
    }
    return value;
  }

  queryRaw(): QueryValues {
    return parseQuery(this.ctx.url);
  }

  /**
   * Query strings are always strings on the wire; the schema does the coercion
   * (`t.integer`, `t.boolean`, …) so a handler never sees `'true'` or `'12'`.
   */
  query<Out>(schema: Schema<Out>): Out {
    const outcome = validateSync(schema, this.queryRaw());
    if (!outcome.ok) throw bodyInvalid(this.pathname, outcome.issues);
    return outcome.value;
  }

  /** Parsed by content-type, cached, size-capped. Returns `undefined` for no body. */
  async bodyRaw(): Promise<unknown> {
    if (this.#body !== undefined) return this.#body.parsed;
    const parsed = await this.#read();
    this.#body = { parsed };
    return parsed;
  }

  async body<Out>(schema: Schema<Out>): Promise<Out> {
    const outcome = await validate(schema, await this.bodyRaw());
    if (!outcome.ok) throw bodyInvalid(this.pathname, outcome.issues);
    return outcome.value;
  }

  /**
   * Version skew: the client sends its build id on every request. A mismatch means
   * the client is holding stale RPC contracts, so it must reload rather than get a
   * confusing validation error three layers down.
   */
  assertBuild(): void {
    const server = this.ctx.config.buildId;
    const client = this.ctx.buildId;
    if (server === null || client === null || client === server) return;
    throw buildSkew(client, server);
  }

  async #read(): Promise<unknown> {
    if (this.method === 'GET' || this.method === 'HEAD') return undefined;
    const limit = this.ctx.config.bodyLimitBytes;
    const header = this.header('content-length');
    // A missing content-length means "unknown", not "empty" — only an explicit 0 is
    // an empty body. Getting this wrong silently drops every chunked request.
    const declared = header === null ? null : Number.parseInt(header, 10);
    if (declared !== null && Number.isFinite(declared) && declared > limit) {
      throw bodyInvalid(this.pathname, [`body is ${declared} bytes, limit is ${limit}`]);
    }
    const type = contentTypeOf(this.raw);
    if (type === '' || declared === 0) return undefined;

    // One capped read for every content type, multipart included: the parser runs on bytes this
    // process already agreed to hold, never on a stream it hands to the runtime unbounded.
    const read = await readWithinLimit(this.raw.body, limit);
    if ('over' in read) {
      throw bodyInvalid(this.pathname, [`body is at least ${read.over} bytes, limit is ${limit}`]);
    }
    if (read.bytes.byteLength === 0) return undefined;

    if (type === 'multipart/form-data') {
      try {
        // Re-parsed from the capped bytes, so the boundary comes from the header it was announced
        // in — `Response` is the one multipart parser here, exactly as `Request` was.
        // Copied, not passed through: a `Uint8Array<ArrayBufferLike>` may be backed by a
        // `SharedArrayBuffer`, which `Response` does not accept.
        const form = await new Response(new Uint8Array(read.bytes), {
          headers: { 'content-type': this.raw.headers.get('content-type') ?? type },
        }).formData();
        return Object.fromEntries(form);
      } catch (error) {
        throw bodyInvalid(this.pathname, [`could not parse ${type}: ${String(error)}`]);
      }
    }

    const body = new TextDecoder().decode(read.bytes);
    try {
      if (type === 'application/json' || type.endsWith('+json')) return JSON.parse(body);
      if (type === 'application/x-www-form-urlencoded') {
        return Object.fromEntries(new URLSearchParams(body));
      }
      if (type.startsWith('text/')) return body;
    } catch (error) {
      throw bodyInvalid(this.pathname, [`could not parse ${type}: ${String(error)}`]);
    }
    throw bodyInvalid(this.pathname, [`unsupported content-type ${type}`]);
  }
}
