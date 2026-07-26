// The typed request. Handlers never touch the raw `Request`: params, query and body
// only exist here in validated form, and actor/locale/tz are read from the request
// context so they cannot drift from what the pipeline resolved.

import type { Actor } from '@ultimat3/core';
import type { RequestContext } from './context';
import { bodyInvalid, buildSkew } from './errors';
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

  get actor(): Actor | null {
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

    // multipart is streamed by the runtime; the declared length is the only guard.
    if (type === 'multipart/form-data') {
      try {
        return Object.fromEntries(await this.raw.formData());
      } catch (error) {
        throw bodyInvalid(this.pathname, [`could not parse ${type}: ${String(error)}`]);
      }
    }

    const buffer = await this.raw.arrayBuffer();
    if (buffer.byteLength > limit) {
      throw bodyInvalid(this.pathname, [`body is ${buffer.byteLength} bytes, limit is ${limit}`]);
    }
    if (buffer.byteLength === 0) return undefined;
    const body = new TextDecoder().decode(buffer);
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
