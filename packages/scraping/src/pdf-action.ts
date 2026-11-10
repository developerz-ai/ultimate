// `pdf()` — a factory over ACTION (`PRIMITIVE_FACTORIES`), never a ninth primitive: render one of
// the app's own routes to PDF through the CDP browser, write it to a disk, answer its key. Input
// schema, policy, rate limit, meter and audit are the action's own, so an invoice PDF is gated
// exactly like the invoice: HTTP, OpenAPI, MCP, `.job()` and `.as()` come with it.

import type { Action, ActionMeter, ActionPolicy, ActionRateLimit } from '@ultimat3/action';
import { action } from '@ultimat3/action';
import type { Ctx } from '@ultimat3/core';
import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';
import type { StorageDriver } from '@ultimat3/storage';
import { pdfOriginMissing, pdfRouteInvalid } from './error-throws-pdf';
import type { PdfRenderer } from './pdf-render';
import { chromePdfRenderer } from './pdf-render';
import type { PdfLayout } from './pdf-request';
import { pdfLayoutOf } from './pdf-request';

export const PDF_CONTENT_TYPE = 'application/pdf';

/** What every `pdf()` answers: where the document is, and how big. Never the bytes themselves. */
const pdfOutput = () => t.object({ key: t.string, bytes: t.number, contentType: t.string });

export type PdfActionOutput = ReturnType<typeof pdfOutput>;

/** What `route`, `key` and `headers` are handed: the parsed input and the call's context. */
export interface PdfActionArgs<TInput extends StandardSchemaV1> {
  readonly input: InferOutput<TInput>;
  readonly ctx: Ctx;
}

export interface PdfActionOptions<TInput extends StandardSchemaV1, TRow = unknown> {
  readonly input: TInput;
  readonly policy: ActionPolicy<TRow>;
  /** A PATH on this app (`/invoices/42/print`). Another origin, or a `//` path, is refused. */
  route(args: PdfActionArgs<TInput>): string;
  /** Where the document lands on `storage`. Tenant-scoped by the app: the key is its to choose. */
  key(args: PdfActionArgs<TInput>): string;
  /** A THUNK, read per call: the app's disks exist after boot, the action at module evaluation. */
  readonly storage: () => StorageDriver;
  /** Checked once, here, by `pdfLayoutOf` — a layout no engine honours never reaches a browser. */
  readonly layout?: PdfLayout | undefined;
  /**
   * Headers the browser sends with every request the page makes — how a private route learns who
   * is printing it (a short-lived token the app signs). Absent: the route must be readable bare.
   */
  readonly headers?:
    | ((args: PdfActionArgs<TInput>) => Readonly<Record<string, string>>)
    | undefined;
  /** The origin the route is served on. Defaults to `APP_URL`, read per call. */
  readonly origin?: (() => string | undefined) | undefined;
  /**
   * Defaults to one `chromePdfRenderer()` the whole process shares — its `maxConcurrent` bounds every
   * `pdf()` that names none. A test hands in one over a fake CDP connection.
   */
  readonly renderer?: PdfRenderer | undefined;
  readonly row?: ((args: PdfActionArgs<TInput>) => TRow | null | Promise<TRow | null>) | undefined;
  readonly rateLimit?: ActionRateLimit | undefined;
  readonly meter?: ActionMeter | undefined;
  readonly audit?: boolean | undefined;
}

const appOrigin = (): string | undefined => process.env['APP_URL'];

let shared: PdfRenderer | undefined;
/**
 * ONE default renderer per process, built on first use: its `maxConcurrent` bounds every `pdf()`
 * that names none, so ten declarations do not mean twenty live Chromes.
 */
const sharedRenderer = (): PdfRenderer => {
  shared ??= chromePdfRenderer();
  return shared;
};

/** The route joined onto the origin, refused unless the result is still that origin. */
function routeUrl(origin: string, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw pdfRouteInvalid(path);
  }
  const base = new URL(origin);
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw pdfRouteInvalid(path);
  return url.href;
}

export function pdf<TInput extends StandardSchemaV1, TRow = unknown>(
  options: PdfActionOptions<TInput, TRow>,
): Action<TInput, PdfActionOutput> {
  const layout = pdfLayoutOf(options.layout ?? {});
  const renderer = options.renderer ?? sharedRenderer();
  const origin = options.origin ?? appOrigin;
  const { row } = options;
  return action<TInput, PdfActionOutput, TRow>({
    input: options.input,
    output: pdfOutput(),
    policy: options.policy,
    ...(row === undefined ? {} : { row: (args) => row(args) }),
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
    ...(options.meter === undefined ? {} : { meter: options.meter }),
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    async handle(args) {
      const served = origin()?.trim();
      if (served === undefined || served === '') throw pdfOriginMissing();
      const url = routeUrl(served, options.route(args));
      const bytes = await renderer.render({
        url,
        layout,
        // A client that went away, or a request past its deadline, frees its slot and its browser.
        signal: args.ctx.signal,
        ...(options.headers === undefined ? {} : { headers: options.headers(args) }),
      });
      const key = options.key(args);
      await options.storage().put(key, bytes, { contentType: PDF_CONTENT_TYPE });
      return { key, bytes: bytes.byteLength, contentType: PDF_CONTENT_TYPE };
    },
  });
}
