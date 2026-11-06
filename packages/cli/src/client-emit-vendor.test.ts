// The vendor client, generated and RUN: a document compiled, the two files written to a scratch
// directory and imported, each call answered by an injected `fetch`. A vendor that renames a field
// is `X_OUTBOUND_BODY_INVALID` naming it, never an `undefined` three calls later.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp; the generated client needs a fresh directory per run.
import { mkdtemp, rm } from 'node:fs/promises';
// why: the scratch directory lives under the OS temp directory, which only node:os names.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { emitVendor } from './client-emit-vendor';
import { compileOpenApi } from './openapi-compile';

const VENDOR_DOC = {
  openapi: '3.0.3',
  info: { title: 'Billing', version: '1' },
  paths: {
    '/v1/invoices/{invoiceId}': {
      get: {
        operationId: 'getInvoice',
        parameters: [
          { in: 'path', name: 'invoiceId', required: true, schema: { type: 'string' } },
          { in: 'query', name: 'expand', schema: { type: 'array', items: { type: 'string' } } },
        ],
        responses: {
          '200': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Invoice' } } },
          },
        },
      },
    },
    '/v1/folders': {
      post: {
        operationId: 'createFolder',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Folder' } } },
        },
        responses: {
          '201': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Folder' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Invoice: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          amount_due: { type: 'integer' },
          status: { type: 'string', enum: ['open', 'paid'] },
          memo: { type: 'string', nullable: true },
        },
        required: ['id', 'amount_due', 'status'],
      },
      Folder: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          children: { type: 'array', items: { $ref: '#/components/schemas/Folder' } },
        },
        required: ['name'],
      },
    },
  },
};

const ROOT = join(import.meta.dir, '..', '..');
const dir = await mkdtemp(join(tmpdir(), 'x-client-vendor-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

/** The emitted files, their framework specifiers pointed at this checkout's sources. */
const emitted = emitVendor('billing', compileOpenApi(VENDOR_DOC, { source: 'billing.json' }));
const local = (text: string): string =>
  text
    .replaceAll("'@ultimat3/core/outbound'", `'${join(ROOT, 'core/src/outbound-subpath.ts')}'`)
    .replaceAll("'@ultimat3/schema'", `'${join(ROOT, 'schema/src/index.ts')}'`);
await Bun.write(join(dir, 'schemas.ts'), local(emitted['schemas.ts']));
await Bun.write(join(dir, 'client.ts'), local(emitted['client.ts']));

interface Sent {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: string | undefined;
}

/** A client whose every call is answered by `answer`, recording what it sent. */
async function clientAnswering(answer: unknown, status = 200) {
  const mod = (await import(join(dir, 'client.ts'))) as {
    createBillingClient(options: unknown): {
      getInvoice(input: unknown): Promise<unknown>;
      createFolder(input: unknown): Promise<unknown>;
    };
  };
  const sent: Sent[] = [];
  const client = mod.createBillingClient({
    baseUrl: 'https://billing.example/',
    dial: 'named',
    deadlineMs: 5_000,
    headers: () => ({ authorization: 'Bearer test' }),
    deps: {
      fetch: async (url: string, init: RequestInit) => {
        sent.push({ url, method: init.method, body: init.body?.toString() });
        return Response.json(answer, { status });
      },
    },
  });
  return { client, sent };
}

describe('vendor client · generated and run', () => {
  test('a GET fills its path and query from the input and parses the answer', async () => {
    const invoice = { id: 'in_1', amount_due: 1200, status: 'open', memo: null };
    const { client, sent } = await clientAnswering(invoice);
    expect(await client.getInvoice({ invoiceId: 'in 1', expand: ['lines', 'tax'] })).toEqual(
      invoice,
    );
    expect(sent).toEqual([
      {
        url: 'https://billing.example/v1/invoices/in%201?expand=lines&expand=tax',
        method: 'GET',
        body: undefined,
      },
    ]);
  });

  test('a renamed field is X_OUTBOUND_BODY_INVALID naming it', async () => {
    const { client } = await clientAnswering({ id: 'in_1', amountDue: 1200, status: 'open' });
    const error = await client.getInvoice({ invoiceId: 'in_1' }).catch((e: unknown) => e);
    expect(error).toBeUltimateError('X_OUTBOUND_BODY_INVALID');
    expect(JSON.stringify((error as { meta?: unknown }).meta)).toContain('amount_due');
  });

  test('a documented non-2xx is X_OUTBOUND_REFUSED with the status', async () => {
    const { client } = await clientAnswering({ error: 'no such invoice' }, 404);
    const error = await client.getInvoice({ invoiceId: 'in_9' }).catch((e: unknown) => e);
    expect(error).toBeUltimateError('X_OUTBOUND_REFUSED');
    expect((error as { meta?: { status?: number } }).meta?.status).toBe(404);
  });

  test('an object body is the input parsed by its schema; a recursive type round-trips', async () => {
    const folder = { name: 'a', children: [{ name: 'b', children: [{ name: 'c' }] }] };
    const { client, sent } = await clientAnswering(folder, 201);
    expect(await client.createFolder({ ...folder, stray: true })).toEqual(folder);
    expect(JSON.parse(sent[0]?.body ?? '{}')).toEqual(folder);
  });

  test('input that breaks the document is refused before a byte leaves', async () => {
    const { client, sent } = await clientAnswering({});
    await expect(client.createFolder({ children: [] })).rejects.toBeUltimateError();
    expect(sent).toEqual([]);
  });
});
