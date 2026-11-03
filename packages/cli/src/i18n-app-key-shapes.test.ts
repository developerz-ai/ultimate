// The shapes against real `defineMail` source, and against `blocks` itself: `@ultimat3/i18n` cannot
// name mail's API, so this file is what notices a new block the gate would not read.

import { describe, expect, test } from 'bun:test';
import { extractKeys } from '@ultimat3/i18n';
import { blocks } from '@ultimat3/mail';
import { APP_KEY_SHAPES } from './i18n-app-key-shapes';

const keysIn = (source: string): readonly string[] =>
  extractKeys(source, 'mail.ts', APP_KEY_SHAPES).usages.map((usage) => usage.key);

const MAIL_SOURCE = `import { blocks, defineMail, t } from '@ultimat3/mail';

export const receipt = defineMail<{ total: string }>({
  id: 'receipt',
  subject: 'mail.receipt.subject',
  input: t.object({ total: t.string }),
  template: ({ data, t: translate }) => [
    blocks.heading('mail.receipt.heading'),
    blocks.paragraph('mail.receipt.body', { total: data.total }),
    blocks.button(
      'mail.receipt.cta',
      'https://example.test',
    ),
    blocks.callout('mail.receipt.note', 'info'),
    blocks.detail('mail.receipt.total', translate('mail.receipt.value')),
    blocks.divider(),
  ],
});
`;

describe('APP_KEY_SHAPES', () => {
  test('every key a real defineMail names is a usage, each once', () => {
    expect([...keysIn(MAIL_SOURCE)].sort()).toEqual([
      'mail.receipt.body',
      'mail.receipt.cta',
      'mail.receipt.heading',
      'mail.receipt.note',
      'mail.receipt.subject',
      'mail.receipt.total',
      'mail.receipt.value',
    ]);
  });

  test('the three translator spellings stay, so the shapes only ever add', () => {
    expect(keysIn("t('a.one'); $t('a.two'); translate('a.three');")).toEqual([
      'a.one',
      'a.two',
      'a.three',
    ]);
  });

  test('every member of blocks that takes a key is listed: a new block reds here', () => {
    const takesKey = Object.entries(blocks).flatMap(([name, make]) => {
      const built: { readonly kind: string; readonly key?: string } = (
        make as (key: string, second: string) => { readonly kind: string; readonly key?: string }
      )('probe.key', 'https://example.test');
      return built.key === 'probe.key' ? [`blocks.${name}`] : [];
    });
    expect(takesKey.length).toBeGreaterThan(0);
    const listed: readonly string[] = APP_KEY_SHAPES.callees;
    expect(listed.filter((callee) => callee.startsWith('blocks.'))).toEqual(takesKey);
  });

  test('a push payload names its keys through titleKey and bodyKey', () => {
    const source = `await push({ titleKey: 'push.title', bodyKey: 'push.body' });`;
    expect(keysIn(source)).toEqual(['push.title', 'push.body']);
  });

  test('subject: is a key only in a file that declares a mail', () => {
    expect(keysIn("const row = { subject: 'Re: your invoice' };")).toEqual([]);
    expect(keysIn("defineMail({ subject: 'mail.a.subject' });")).toEqual(['mail.a.subject']);
  });

  test('a built block key is dynamic, and says so', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
    const source = 'blocks.paragraph(`mail.${id}.body`);';
    const extraction = extractKeys(source, 'mail.ts', APP_KEY_SHAPES);
    expect(extraction.usages).toEqual([]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the expression is source text
    expect(extraction.dynamic.map((entry) => entry.expression)).toEqual(['`mail.${id}.body`']);
  });
});
