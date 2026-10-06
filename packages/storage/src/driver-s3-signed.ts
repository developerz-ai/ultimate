// Single responsibility: the s3 disk's SIGNED requests — the ones `Bun.S3Client` has no option for
// (`x-amz-meta-*`, `Cache-Control`, `x-amz-object-lock-*`, `?retention`, `?legal-hold`) — built,
// signed through core's one SigV4 signer and sent with `fetch`. The endpoint, the addressing style,
// the region and the credentials are read from the SAME `S3DriverOptions` the Bun client is built
// from, so the two transports of one disk cannot point at two buckets.

import {
  type AwsCredentials,
  type Clock,
  ConfigInvalidError,
  EnvMissingError,
  signAwsRequest,
  systemClock,
} from '@ultimat3/core';

/** The slice of `fetch` this file uses; injected in tests so no socket is ever opened. */
export type S3FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: Uint8Array<ArrayBuffer> | undefined;
  },
) => Promise<Response>;

/** Structurally `S3DriverOptions`, so the driver passes its own options through unchanged. */
export interface S3WireOptions {
  readonly bucket: string;
  readonly region?: string | undefined;
  readonly endpoint?: string | undefined;
  readonly forcePathStyle?: boolean | undefined;
  readonly accessKeyIdEnv?: string | undefined;
  readonly secretAccessKeyEnv?: string | undefined;
  readonly sessionTokenEnv?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly fetch?: S3FetchLike | undefined;
  readonly clock?: Clock | undefined;
}

/**
 * What a provider's refusal is read as — the `code`/`message`/`statusCode` triple `Bun.S3Client`'s
 * `S3Error` carries, so `regionMismatch` and `isAbsentObject` classify a signed request's failure
 * exactly as they classify the Bun client's. A plain object: it is never thrown bare, only handed
 * to a coded factory.
 */
export interface S3Refusal {
  readonly name: 'S3Error';
  readonly code: string;
  readonly message: string;
  readonly statusCode: number;
}

export interface S3SignedRequest {
  readonly method: 'GET' | 'PUT';
  readonly key: string;
  /** A sub-resource such as `retention` — sent and signed as `?retention=`. */
  readonly subresource?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: Uint8Array | undefined;
}

export type S3SignedResult =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly refusal: S3Refusal };

/** One credential reader for both transports: an unset or empty variable is `X_ENV_MISSING`. */
export function requireEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  partner: string,
): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new EnvMissingError({
      cause: `${name} is not set, so the s3 disk cannot authenticate`,
      fix: `set ${name} and ${partner} in .env (or the container's secret store), then re-run`,
      meta: { missing: name },
    });
  }
  return value;
}

/** Read lazily, at the first signed request — importing or constructing the disk reads nothing. */
export function s3Credentials(options: S3WireOptions): AwsCredentials {
  const env = options.env ?? process.env;
  const idVar = options.accessKeyIdEnv ?? 'S3_ACCESS_KEY_ID';
  const secretVar = options.secretAccessKeyEnv ?? 'S3_SECRET_ACCESS_KEY';
  const tokenVar = options.sessionTokenEnv;
  const sessionToken = tokenVar === undefined ? undefined : env[tokenVar];
  return {
    accessKeyId: requireEnv(env, idVar, secretVar),
    secretAccessKey: requireEnv(env, secretVar, idVar),
    ...(sessionToken === undefined || sessionToken === '' ? {} : { sessionToken }),
  };
}

/**
 * Bun's addressing, restated: path style unless `forcePathStyle` is EXPLICITLY false (Bun's own
 * `virtualHostedStyle` defaults to false), and AWS's regional endpoint when none is configured.
 */
export function s3ObjectUrl(options: S3WireOptions, key: string): URL {
  const endpoint = options.endpoint ?? `https://s3.${options.region ?? 'us-east-1'}.amazonaws.com`;
  const base = new URL(endpoint);
  const path = key.split('/').map(encodeURIComponent).join('/');
  if (options.forcePathStyle === false) {
    return new URL(`${base.protocol}//${options.bucket}.${base.host}/${path}`);
  }
  const prefix = base.pathname.replace(/\/+$/, '');
  return new URL(
    `${base.protocol}//${base.host}${prefix}/${encodeURIComponent(options.bucket)}/${path}`,
  );
}

const XML_FIELD = (name: string): RegExp => new RegExp(`<${name}>([^<]{0,512})</${name}>`);

/** The first `<name>…</name>` of an S3 XML answer — the shapes read here are flat and fixed. */
export function xmlField(xml: string, name: string): string | undefined {
  return XML_FIELD(name).exec(xml)?.[1]?.trim();
}

/** A non-2xx answer as the refusal it is. A HEAD-style empty body still has its status. */
async function refusalOf(response: Response): Promise<S3Refusal> {
  const body = await response.text().catch(() => '');
  return {
    name: 'S3Error',
    code: xmlField(body, 'Code') ?? `HTTP${response.status}`,
    message: xmlField(body, 'Message') ?? response.statusText,
    statusCode: response.status,
  };
}

/**
 * Sign and send one request. Resolves with the response or the provider's refusal — never throws
 * for an answer the provider gave, so each caller decides what a refusal means for ITS call. A
 * request with no answer at all (DNS, reset) rejects with whatever `fetch` raised.
 */
export async function sendSigned(
  options: S3WireOptions,
  request: S3SignedRequest,
): Promise<S3SignedResult> {
  // The Bun client's own refusal, for the transport beside it: one disk, one rule.
  if (options.bucket === '') {
    throw new ConfigInvalidError({
      cause: 's3 disk was defined without a bucket',
      fix: "s3Driver({ bucket: 'my-bucket' })   # storage.disks.<name> in app.config.ts",
    });
  }
  const url = s3ObjectUrl(options, request.key);
  if (request.subresource !== undefined) url.search = `${request.subresource}=`;
  const signed = await signAwsRequest({
    method: request.method,
    url,
    headers: request.headers ?? {},
    // The body is in memory and bounded by `maxPutBytes`, so it is hashed and the provider can
    // refuse a body that changed in flight; a read has none.
    payload: { body: request.body ?? new Uint8Array() },
    credentials: s3Credentials(options),
    region: options.region ?? 'auto',
    service: 's3',
    clock: options.clock ?? systemClock,
  });
  const send = options.fetch ?? fetch;
  const body = request.body;
  const response = await send(signed.url, {
    method: signed.method,
    headers: signed.headers,
    // `fetch` takes an ArrayBuffer-backed view; only a view over shared memory is copied.
    ...(body === undefined
      ? {}
      : {
          body:
            body.buffer instanceof ArrayBuffer
              ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
              : new Uint8Array(body),
        }),
  });
  return response.ok ? { ok: true, response } : { ok: false, refusal: await refusalOf(response) };
}
