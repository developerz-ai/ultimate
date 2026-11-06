// The `/_x` mail panel's templates: every registered mail, each declared `preview` rendered per
// locale through `@ultimat3/mail`, a schema refusal shown as its instruction rather than thrown.

import { afterEach, describe, expect, test } from 'bun:test';
import { loadCatalog, registerCatalog } from '@ultimat3/i18n';
import { blocks, defineMail, resetMails } from '@ultimat3/mail';
import { t } from '@ultimat3/schema';
import { mailTemplateFacts } from './dev-mail-templates';

registerCatalog('en', loadCatalog({ devtpl: { subject: 'Hi {name}', body: 'Welcome, {name}.' } }));
registerCatalog('es', loadCatalog({ devtpl: { subject: 'Hola {name}' } }));

afterEach(() => resetMails());

const input = t.object({ name: t.string.min(1) });
const template = ({ data }: { data: { name: string } }) => [
  blocks.paragraph('devtpl.body', { name: data.name }),
];

describe('mailTemplateFacts', () => {
  test('a declared preview renders once per locale; a mail without one is listed as such', () => {
    defineMail({
      id: 'devtpl-welcome',
      subject: 'devtpl.subject',
      input,
      template,
      preview: { name: 'Ada' },
    });
    defineMail({ id: 'devtpl-receipt', subject: 'devtpl.subject', input, template });
    // The framework's own mails (auth's) are registered in this process too: every one is listed.
    const facts = mailTemplateFacts(['en', 'es']).filter((fact) => fact.id.startsWith('devtpl-'));
    // The registry's order: sorted by id.
    expect(facts.map((fact) => [fact.id, fact.hasPreview])).toEqual([
      ['devtpl-receipt', false],
      ['devtpl-welcome', true],
    ]);
    const [en, es] = facts[1]?.previews ?? [];
    expect(en).toMatchObject({ locale: 'en', ok: true, subject: 'Hi Ada', missing: [] });
    // Spanish has no body: named, so the panel shows the gap before anything is sent.
    expect(es).toMatchObject({
      locale: 'es',
      ok: true,
      subject: 'Hola Ada',
      missing: ['devtpl.body'],
    });
    expect(facts[0]?.previews).toEqual([]);
  });

  test('a preview function its schema refuses is the instruction, never a crashed panel', () => {
    defineMail({
      id: 'devtpl-broken',
      subject: 'devtpl.subject',
      input,
      template,
      preview: () => ({ name: '' }),
    });
    const fact = mailTemplateFacts(['en']).find((one) => one.id === 'devtpl-broken');
    expect(fact?.previews[0]).toMatchObject({
      locale: 'en',
      ok: false,
      error: { code: 'X_MAIL_PREVIEW_INVALID' },
    });
  });
});
