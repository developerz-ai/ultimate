// The typed request. Handlers never touch the raw `Request`: params, query and body
// only exist here in validated form, and actor/locale/tz are read from the request
// context so they cannot drift from what the pipeline resolved.

import type { Actor } from '@ultimat3/core';
import { readWithinLimit, renderThrowable } from '@ultimat3/core';
import type { RequestContext } from './context';
import { bodyInvalid, buildSkew } from './errors';
import { readCookie } from './locale';
import type { Schema } from './validate';
import { validate, validateSync } from './validate';

export type QueryValues = Readonly<Record<string, string | readonly string[]>>;

const contentTypeOf = (request: Request): string =>
  (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

/**
 * Repeated keys become arrays; everything else stays a string for the schema to coerce.
 *
 * `Object.create(null)`, never `{}`: on a plain object `out['__proto__']` never reads as
 * `undefined` — it reads the inherited `Object.prototype` — so the FIRST `?__proto__=` took the
 * repeated-key branch below and assigned an array through the `__proto__` SETTER, which accepts an
 * object and swapped this object's prototype for it. One occurrence was enough. A null prototype
 * has neither accessor, so `__proto__` is an ordinary key here, and `key in record` — how
 * `coerceQuery` decides whether to coerce a declared property — stops answering true for every
 * member of `Object.prototype`.
 */
const collectFields = <T>(entries: Iterable<[string, T]>): Record<string, T | T[]> => {
  const out: Record<string, T | T[]> = Object.create(null);
  for (const [key, value] of entries) {
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
};

const parseQuery = (url: URL): QueryValues => collectFields(url.searchParams);

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

  /**
   * Build id the CLIENT thinks it is running. See `assertBuild()`. Not `ctx.buildId`, which is
   * core's meaning of the word — the build this PROCESS serves — and the one every other layer
   * reads off the ambient context.
   */
  get buildId(): string | null {
    return this.ctx.clientBuildId;
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
    const client = this.ctx.clientBuildId;
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
        // `collectFields`, never `Object.fromEntries`: a repeated name is a LIST here for the
        // reason it is one in the query — a checkbox group posts its name once per checked box,
        // and collapsing to the last one silently discards every other answer.
        return collectFields(form);
      } catch (error) {
        // The parser's own message is a diagnostic, not an instruction, and it quotes the bytes
        // it choked on — so it rides in `meta`, rendered by core rather than by `String(error)`,
        // which is itself a `TypeError` on a null-prototype throwable.
        throw bodyInvalid(this.pathname, ['could not parse multipart/form-data'], {
          parseError: renderThrowable(error),
        });
      }
    }

    const body = new TextDecoder().decode(read.bytes);
    try {
      if (type === 'application/json' || type.endsWith('+json')) return JSON.parse(body);
      if (type === 'application/x-www-form-urlencoded') {
        return collectFields(new URLSearchParams(body));
      }
      if (type.startsWith('text/')) return body;
    } catch (error) {
      // `JSON.parse` is the only thing above that throws — `new URLSearchParams(s)` and the
      // `text/` branch accept any string — so the caller-facing half can name the format without
      // echoing the `content-type` header the caller chose.
      throw bodyInvalid(this.pathname, ['could not parse the body as JSON'], {
        parseError: renderThrowable(error),
        contentType: type,
      });
    }
    // The list of what IS accepted, which is the actionable half; the value the caller sent is
    // theirs already and is a log field here rather than a string in the message.
    throw bodyInvalid(
      this.pathname,
      [
        'content-type is not one of application/json, application/x-www-form-urlencoded, ' +
          'multipart/form-data, text/*',
      ],
      { contentType: type },
    );
  }
}
