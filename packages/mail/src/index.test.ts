// The barrel must re-export the ONE `t` from `@ultimat3/schema` by identity, never a copy — `t`
// delegates to `schemaProvider()` on every access, so a spread or a re-declaration would freeze
// the provider at import time and still typecheck, still build a `defineMail` input. Identity is
// the only assertion that catches that, which is why this file exists.

import { describe, expect, test } from 'bun:test';
import { parse, t as schemaT } from '@ultimat3/schema';
import { blocks, defineMail, t } from './index';

describe('@ultimat3/mail public surface', () => {
  test('re-exports the one `t`, not a copy of it', () => {
    // A spread or a re-implementation would still typecheck but would stop tracking
    // `configureSchemaProvider()`. Identity is the only assertion that catches that.
    expect(t).toBe(schemaT);
  });

  test('the re-exported `t` builds a working `defineMail` input', () => {
    const receipt = defineMail({
      id: 'index.test.receipt',
      subject: 'mail.receipt.subject',
      input: t.object({ name: t.string, url: t.url }),
      template: ({ data }) => [blocks.heading('mail.receipt.heading', { name: data.name })],
    });

    // `input` is typed as the vendor-agnostic `StandardSchemaV1` — that is the swap point that
    // lets a mail carry an ArkType or Zod schema — so it is read through schema's `parse()`,
    // never through the `.parse()` method only Ultimate's own builder happens to expose.
    expect(parse(receipt.input, { name: 'Ada', url: 'https://example.com' })).toEqual({
      name: 'Ada',
      url: 'https://example.com',
    });
    expect(() => parse(receipt.input, { name: 'Ada', url: 'not-a-url' })).toThrow();
  });
});

describe('@ultimat3/mail/events stays off the barrel', () => {
  // Every serving role evaluates the barrel; SNS/Svix verification is for a webhook route only.
  test('the receivers are on the subpath and not on the barrel', async () => {
    const barrel: Record<string, unknown> = await import('./index');
    const events: Record<string, unknown> = await import('./events');
    for (const name of ['createSesEventReceiver', 'createResendEventReceiver']) {
      expect(typeof events[name]).toBe('function');
      expect(barrel[name]).toBeUndefined();
    }
    const barrelSource = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    expect(barrelSource).not.toMatch(/from '\.\/(?:ses|resend)-event-receiver'/);
    expect(barrelSource).not.toMatch(/from '\.\/(?:sns|resend)-signature'/);
    expect(barrelSource).not.toMatch(/^export \{[^}]*\} from '\.\/delivery-event/m);
  });
});
