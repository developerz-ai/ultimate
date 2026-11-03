import { expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { loadCatalog, registerCatalog } from '@ultimat3/i18n';
import { blocks } from './blocks';
import { BASE_LAYOUT, MAIL_TOKENS, type MailToken } from './layout';
import { type RenderableMail, renderMail } from './render';

registerCatalog(
  'en',
  loadCatalog({
    test: {
      render: {
        subject: 'Report for {name}',
        heading: 'Hello {name}',
        body: 'Nothing to do — this is a receipt.',
        cta: 'Open the report',
      },
    },
  }),
);

interface Payload {
  readonly name: string;
  readonly url: string;
}

const normalMail: RenderableMail<Payload> = {
  id: 'test-render',
  subject: 'test.render.subject',
  layout: BASE_LAYOUT,
  template: ({ data }) => [
    blocks.heading('test.render.heading', { name: data.name }),
    blocks.paragraph('test.render.body'),
    blocks.button('test.render.cta', data.url),
  ],
};

const textlessMail: RenderableMail<Payload> = {
  id: 'test-textless',
  subject: 'test.render.subject',
  layout: BASE_LAYOUT,
  // A template that emits only structural blocks: HTML-only mail, which is the bug.
  template: () => [blocks.divider(), blocks.divider()],
};

const options = { locale: 'en', tz: 'UTC' } as const;

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'no error thrown';
  } catch (error) {
    return isUltimateError(error) ? error.code : `not an UltimateError: ${String(error)}`;
  }
}

test('a complete render misses nothing, and a hole is reported without being hidden', () => {
  const payload = { name: 'Ada', url: 'https://x.test' };
  expect(renderMail(normalMail, payload, options).misses).toEqual([]);

  const rendered = renderMail({ ...normalMail, subject: 'test.render.absent' }, payload, options);
  expect(rendered.misses).toEqual([{ key: 'test.render.absent', slot: undefined }]);
  expect(rendered.subject).toBe('\u27E6test.render.absent\u27E7');
});

test('an optional footer or preheader a locale lacks is no miss: the render never asked for it', () => {
  const rendered = renderMail(
    normalMail,
    { name: 'Ada', url: 'https://x.test' },
    {
      locale: 'tlh',
      tz: 'UTC',
    },
  );
  const keys = rendered.misses.map((miss) => miss.key);
  expect(keys).not.toContain('mail.footer.legal');
  expect(keys).not.toContain('mail.test-render.preheader');
  expect(keys).toContain('test.render.subject');
});

test('a plural with a count resolves through the locale, and a slot the count fills is no miss', () => {
  const plural: RenderableMail<Payload> = {
    ...normalMail,
    template: () => [
      blocks.paragraph('test.render.items', { count: 3 }),
      blocks.paragraph('test.render.items', { count: 3, of: 9 }),
    ],
  };
  registerCatalog(
    'en',
    loadCatalog({
      test: { render: { items_one: '{count} item', items_other: '{count} of {of}' } },
    }),
  );
  const rendered = renderMail(plural, { name: 'Ada', url: 'https://x.test' }, options);
  expect(rendered.misses).toEqual([{ key: 'test.render.items', slot: 'of' }]);
});

test('a template with no text blocks throws X_MAIL_TEXT_MISSING', () => {
  const payload = { name: 'Ada', url: 'https://x.test' };
  expect(codeOf(() => renderMail(textlessMail, payload, options))).toBe('X_MAIL_TEXT_MISSING');
});

test('an unregistered layout is X_MAIL_TEMPLATE_UNKNOWN', () => {
  const bad: RenderableMail<Payload> = { ...normalMail, layout: 'nope' };
  expect(codeOf(() => renderMail(bad, { name: 'Ada', url: 'https://x.test' }, options))).toBe(
    'X_MAIL_TEMPLATE_UNKNOWN',
  );
});

test('a normal render returns both parts, inlined, with no token names leaked', () => {
  const rendered = renderMail(
    normalMail,
    { name: 'Ada', url: 'https://example.test/report' },
    options,
  );

  expect(rendered.subject).toBe('Report for Ada');
  expect(rendered.html).toContain('Hello Ada');
  expect(rendered.text).toContain('Hello Ada');
  expect(rendered.text).toContain('https://example.test/report');

  // Styling is inlined: clients that strip <style> still get the design.
  expect(rendered.html).toContain('style="');
  expect(rendered.html).toContain(MAIL_TOKENS.accentBg.light);
  // ...and the one <style> block is the dark-mode override, nothing else.
  expect(rendered.html).toContain('@media (prefers-color-scheme:dark)');
  expect(rendered.html).toContain(MAIL_TOKENS.surfaceBg.dark);

  // No class-based styling dependency anywhere in the delivered HTML.
  expect(rendered.html).not.toContain('class=');

  // No design-token name survives into the output — hexes are resolved at render time.
  for (const name of Object.keys(MAIL_TOKENS) as MailToken[]) {
    expect(rendered.html.includes(name)).toBe(false);
  }
  expect(rendered.html).not.toContain('var(--');
});

test('interpolated values are HTML-escaped in the html part', () => {
  const rendered = renderMail(
    normalMail,
    { name: '<script>alert(1)</script>', url: 'https://example.test/r' },
    options,
  );

  expect(rendered.html).not.toContain('<script>');
  expect(rendered.html).toContain('&lt;script&gt;');
  // The text part is not escaped — it is text, and it must stay readable.
  expect(rendered.text).toContain('<script>alert(1)</script>');
});

test('a javascript: href is neutralised rather than escaped through', () => {
  const rendered = renderMail(normalMail, { name: 'Ada', url: 'javascript:alert(1)' }, options);

  expect(rendered.html).not.toContain('javascript:');
  expect(rendered.html).toContain('href="#"');
});

test('the preheader falls back to the subject when no preheader key exists', () => {
  const rendered = renderMail(normalMail, { name: 'Ada', url: 'https://x.test' }, options);
  expect(rendered.preheader).toBe('Report for Ada');
  expect(rendered.html).toContain('mso-hide:all');
});
