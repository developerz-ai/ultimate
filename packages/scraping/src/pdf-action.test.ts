// `pdf()` is an action: its input schema refuses before a browser starts, its policy refuses an
// actor before a byte is printed, and an allowed call renders the app's OWN route and writes the
// bytes to the disk under the key the app chose.

import { afterEach, describe, expect, test } from 'bun:test';
import { resetActions } from '@ultimat3/action';
import { registerAction } from '@ultimat3/action/loader';
import { userActor } from '@ultimat3/core';
import { allow, deny } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { memoryStorageDriver } from '@ultimat3/storage';
import { pdf } from './pdf-action';
import type { PdfRenderer, PdfRenderRequest } from './pdf-render';

afterEach(() => {
  resetActions();
});

const ana = userActor({ id: 'ana', orgId: 'o1' });
const BYTES = new TextEncoder().encode('%PDF-1.7 invoice');

function recordingRenderer(): PdfRenderer & { readonly seen: PdfRenderRequest[] } {
  const seen: PdfRenderRequest[] = [];
  return {
    seen,
    render(request) {
      seen.push(request);
      return Promise.resolve(BYTES);
    },
  };
}

function invoicePdf(
  overrides: { route?: string; origin?: string | undefined; allowed?: boolean } = {},
) {
  const renderer = recordingRenderer();
  const disk = memoryStorageDriver();
  const declared = pdf({
    input: t.object({ id: t.string.min(1) }),
    policy: overrides.allowed === false ? deny('invoices.not-yours') : allow(),
    route: ({ input }) => overrides.route ?? `/invoices/${input.id}/print`,
    key: ({ input, ctx }) => `invoices/${ctx.actor.id}/${input.id}.pdf`,
    storage: () => disk,
    layout: { format: 'a4' },
    headers: () => ({ authorization: 'Bearer short-lived' }),
    origin: () => ('origin' in overrides ? overrides.origin : 'https://app.test'),
    renderer,
  });
  resetActions();
  return { action: registerAction('invoicePdf', declared), renderer, disk };
}

const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return expect.unreachable('expected a refusal');
};

describe('unit · pdf()', () => {
  test('renders the app route and stores the bytes under the key it answers', async () => {
    const { action, renderer, disk } = invoicePdf();
    const answer = await action.as(ana, { id: '42' });
    expect(answer).toEqual({
      key: 'invoices/ana/42.pdf',
      bytes: BYTES.byteLength,
      contentType: 'application/pdf',
    });
    expect(renderer.seen).toMatchObject([
      {
        url: 'https://app.test/invoices/42/print',
        layout: { format: 'a4' },
        headers: { authorization: 'Bearer short-lived' },
      },
    ]);
    // The call's own cancellation reaches the renderer, so a dropped request frees its browser.
    expect(renderer.seen[0]?.signal).toBeInstanceOf(AbortSignal);
    const stored = await disk.get('invoices/ana/42.pdf');
    expect(new TextDecoder().decode(stored.bytes)).toBe('%PDF-1.7 invoice');
  });

  test('the input schema refuses before any browser is asked', async () => {
    const { action, renderer } = invoicePdf();
    expect(await codeOf(() => action.as(ana, { id: '' }))).toBe('X_INPUT_INVALID');
    expect(renderer.seen).toEqual([]);
  });

  test('the policy refuses before any browser is asked', async () => {
    const { action, renderer } = invoicePdf({ allowed: false });
    expect(await codeOf(() => action.as(ana, { id: '42' }))).toBe('X_FORBIDDEN');
    expect(renderer.seen).toEqual([]);
  });

  test('a route that leaves the origin is refused, never loaded', async () => {
    for (const route of ['https://evil.test/x', '//evil.test/x', 'invoices/42', '/\\evil.test']) {
      const { action, renderer } = invoicePdf({ route });
      expect(await codeOf(() => action.as(ana, { id: '42' }))).toBe('X_SCRAPE_PDF_ROUTE_INVALID');
      expect(renderer.seen).toEqual([]);
    }
  });

  test('no origin is X_SCRAPE_PDF_ORIGIN_MISSING', async () => {
    const { action } = invoicePdf({ origin: undefined });
    expect(await codeOf(() => action.as(ana, { id: '42' }))).toBe('X_SCRAPE_PDF_ORIGIN_MISSING');
  });

  test('a layout no engine honours is refused where pdf() is written', () => {
    expect(() =>
      pdf({
        input: t.object({}),
        policy: allow(),
        route: () => '/x',
        key: () => 'x.pdf',
        storage: () => memoryStorageDriver(),
        layout: { format: 'a4', widthMm: 100, heightMm: 100 },
        renderer: recordingRenderer(),
      }),
    ).toThrow(expect.objectContaining({ code: 'X_SCRAPE_PDF_OPTIONS_INVALID' }));
  });
});
