// `emitCustomer`, as text, over a document small enough to read: each body mode, each refusal
// shape, a summary that would close its own comment, and the types file. The compile under
// `strict` and the real calls are `client-emit-customer.contract.test.ts`'s, against the reference
// app's whole document.

import { describe, expect, test } from 'bun:test';
import { bodyKeys, emitCustomer } from './client-emit-customer';
import { compileOpenApi } from './openapi-compile';

const json = (schema: unknown): Readonly<Record<string, unknown>> => ({
  content: { 'application/json': { schema } },
});

const compiled = compileOpenApi(
  {
    openapi: '3.1.0',
    info: { title: 'Billing', version: '2026-11-01' },
    paths: {
      '/invoices/{invoiceId}': {
        post: {
          operationId: 'payInvoice',
          summary: 'Pay one invoice */ now',
          parameters: [
            { name: 'invoiceId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'dryRun', in: 'query', schema: { type: 'boolean' } },
            { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } },
          ],
          requestBody: { required: true, ...json({ $ref: '#/components/schemas/Payment' }) },
          responses: {
            '200': json({ $ref: '#/components/schemas/Invoice' }),
            '409': { description: 'refused', 'x-ultimate-errors': ['X_PAID', 'X_VOID'] },
          },
        },
      },
      '/invoices/{invoiceId}/note': {
        put: {
          operationId: 'setNote',
          parameters: [
            { name: 'invoiceId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: json({ type: 'string' }),
          responses: { '204': { description: 'kept' } },
        },
      },
      '/health': {
        get: { operationId: 'health', responses: { '204': { description: 'up' } } },
      },
    },
    components: {
      schemas: {
        Payment: {
          type: 'object',
          properties: { amount: { type: 'integer' }, currency: { type: 'string' } },
          required: ['amount', 'currency'],
        },
        Invoice: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
  },
  { source: 'test' },
);
const files = emitCustomer(compiled);
const operation = (name: string) => {
  const found = compiled.operations.find((op) => op.name === name);
  if (found === undefined) return expect.unreachable(`the document compiled no ${name}`);
  return found;
};

describe('emitCustomer', () => {
  test('a fields body sends the keys its $ref names; a value body and no body send none', () => {
    expect(bodyKeys(compiled, operation('payInvoice'))).toEqual(['amount', 'currency']);
    expect(bodyKeys(compiled, operation('setNote'))).toEqual([]);
    expect(bodyKeys(compiled, operation('health'))).toEqual([]);

    const index = files['index.ts'];
    expect(index).toContain('body: ["amount","currency"]');
    expect(index).toContain("body: 'value'");
    expect(index).toContain("body: 'none'");
    // Where each parameter goes, read off the document, never guessed from the name.
    expect(index).toContain(
      'pathParams: ["invoiceId"], query: ["dryRun"], headers: ["Idempotency-Key"]',
    );
  });

  test('declared refusals are a union, none is never, and refusalOf narrows only declared ones', () => {
    const index = files['index.ts'];
    expect(index).toContain('  payInvoice: "X_PAID" | "X_VOID";');
    expect(index).toContain('  health: never;');
    expect(index).toContain('  payInvoice: ["X_PAID","X_VOID"],');
    expect(index).toContain('export function refusalOf<K extends keyof Refusals>');
  });

  test('a method per operation: typed input, void for no answer, the summary unable to close', () => {
    const index = files['index.ts'];
    expect(index).toContain("import type * as T from './types';");
    expect(index).toContain('    /** Pay one invoice * / now */\n    payInvoice: (input: T.');
    expect(index).toMatch(
      /health: \(input: Record<string, never> = \{\}, call: CallOptions = \{\}\): Promise<void>/,
    );
    expect(index).toContain('empty: true');
    expect(index).toContain('export type Client = ReturnType<typeof createClient>;');
  });

  test('the types file declares every component and each operation type, importing nothing', () => {
    const types = files['types.ts'];
    expect(types.startsWith('// The types of Billing 2026-11-01')).toBe(true);
    expect(types).toContain('export type Payment = ');
    expect(types).toContain('export type Invoice = ');
    expect(types).not.toContain('import ');
    expect(types.endsWith('\n')).toBe(true);
  });
});
