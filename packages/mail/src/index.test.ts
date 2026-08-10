// The barrel must re-export the ONE `t` from `@ultimat3/schema` by identity, never a copy — `t`
// delegates to `schemaProvider()` on every access, so a spread or a re-declaration would freeze
// the provider at import time and still typecheck, still build a `defineMail` input. Identity is
// the only assertion that catches that, which is why this file exists.

import { describe, expect, test } from 'bun:test';
import { t as schemaT } from '@ultimat3/schema';
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

    expect(receipt.input?.parse({ name: 'Ada', url: 'https://example.com' })).toEqual({
      name: 'Ada',
      url: 'https://example.com',
    });
    expect(() => receipt.input?.parse({ name: 'Ada', url: 'not-a-url' })).toThrow();
  });
});
