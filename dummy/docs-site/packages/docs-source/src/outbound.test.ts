import { expect, test } from 'bun:test';
import { readCorpus } from './corpus';
import { FIXTURE_OPTIONS, WIKI } from './corpus-fixture';
import { outboundLinks } from './outbound';
import type { DocPiece, DocsCorpus } from './types';

const piece = (url: string, markdown: string): DocPiece => ({
  url,
  file: 'Page.md',
  title: url,
  lead: url,
  markdown,
  headings: [],
});

const corpus = (over: Partial<DocsCorpus>): DocsCorpus => ({
  pages: [],
  codes: [],
  majors: [],
  ...over,
});

test('a link the real reader keeps as written is outbound, and an internal one is not', () => {
  const urls = outboundLinks(readCorpus(WIKI, FIXTURE_OPTIONS)).map((link) => link.url);
  expect(urls).toContain('https://github.com/developerz-ai/ultimate');
  expect(urls.every((url) => url.startsWith('http'))).toBe(true);
});

test('one URL is one entry, its fragment dropped, naming every page that links it', () => {
  const links = outboundLinks(
    corpus({
      pages: [piece('/a', '[x](https://nextjs.org/docs#top)')],
      majors: [{ ...piece('/upgrading/30', '[y](https://nextjs.org/docs)'), major: 30 }],
    }),
  );
  expect(links).toEqual([{ url: 'https://nextjs.org/docs', pages: ['/a', '/upgrading/30'] }]);
});

test('an error-code page is read too: its cells carry links of their own', () => {
  const links = outboundLinks(
    corpus({
      codes: [
        {
          code: 'X_A',
          url: '/errors/X_A',
          rows: [
            {
              section: { title: 'Core', url: '/error-codes-core' },
              cells: [{ label: 'Fix', markdown: '[guide](https://bun.sh/docs)' }],
            },
          ],
        },
      ],
    }),
  );
  expect(links).toEqual([{ url: 'https://bun.sh/docs', pages: ['/errors/X_A'] }]);
});

test('entries are sorted, so two runs probe in one order and replay the same steps', () => {
  const links = outboundLinks(
    corpus({ pages: [piece('/a', '[z](https://z.dev/) [a](https://a.dev/)')] }),
  );
  expect(links.map((link) => link.url)).toEqual(['https://a.dev/', 'https://z.dev/']);
});

test.each([
  ['a reserved name', '[x](https://postly.example/a)'],
  ['a reserved second-level name', '[x](https://example.com/a)'],
  ['loopback', '[x](http://localhost:3000/)'],
  ['a site path', '[x](/getting-started)'],
  ['a mail address', '[x](mailto:someone@bun.sh)'],
  ['a link inside a fence', '```\n[x](https://bun.sh/)\n```'],
])('%s is nothing a probe could answer about', (_name, markdown) => {
  expect(outboundLinks(corpus({ pages: [piece('/a', markdown)] }))).toEqual([]);
});
