import { describe, expect, test } from 'bun:test';
import { readCorpus } from './corpus';
import { FIXTURE_OPTIONS, GUIDE, WIKI } from './corpus-fixture';
import { DocsLinkDeadError, DocsPieceOversizeError } from './errors';
import type { DocPiece } from './types';

const corpus = readCorpus(WIKI, FIXTURE_OPTIONS);
const page = (url: string): DocPiece => {
  const found = [...corpus.pages, ...corpus.majors].find((piece) => piece.url === url);
  if (found === undefined) return expect.unreachable(`no piece at ${url}`);
  return found;
};

describe('readCorpus · pages', () => {
  test('one page per wiki file, chrome files skipped, Home at /docs', () => {
    expect(corpus.pages.map((piece) => piece.url).sort()).toEqual([
      '/docs',
      '/error-codes',
      '/error-codes-core',
      '/error-codes-db',
      '/getting-started',
      '/upgrading',
    ]);
  });

  test('the title is the # heading, which leaves the body; comments are gone', () => {
    const guide = page('/getting-started');
    expect(guide.title).toBe('Getting started');
    expect(guide.markdown).not.toContain('# Getting started');
    expect(guide.markdown).not.toContain('<!--');
    expect(guide.lead).toBe('Four commands.');
    expect(guide.headings).toEqual([{ level: 2, text: 'Install', anchor: 'install' }]);
  });

  test('links land on the piece that holds their target, at the anchor it carries there', () => {
    const guide = page('/getting-started').markdown;
    expect(guide).toContain('[Move to 30](/upgrading/30)');
    // `Removed` is `removed-1` on the whole wiki page and `removed` on major 29's own page.
    expect(guide).toContain('[removed](/upgrading/29#removed)');
    expect(guide).toContain('[up](#install)');
    expect(guide).toContain('[drift](/error-codes-db)');
    expect(guide).toContain('(https://github.com/developerz-ai/ultimate)');
    expect(page('/docs').markdown).toContain(
      '[codes](/error-codes#reserved-codes) and [the footer](#footer)',
    );
    expect(page('/upgrading/30').markdown).toContain('[back](/upgrading#what-semver-covers)');
  });
});

describe('readCorpus · splits', () => {
  test('a major per `→ M.0.0` heading, newest first; the index lists them where they stood', () => {
    expect(corpus.majors.map((piece) => [piece.major, piece.title])).toEqual([
      [30, '29.x → 30.0.0, entry by entry'],
      [29, '28.x → 29.0.0, entry by entry'],
    ]);
    const index = page('/upgrading').markdown;
    expect(index).toContain('- [29.x → 30.0.0, entry by entry](/upgrading/30)');
    expect(index).toContain('## What semver covers');
    expect(index).not.toContain('Thirty moved things');
  });

  // Every page of the set splits: an owner page's rows and the index's reserved rows alike, and a
  // code with a row on two owner pages gathers both — each linking back to the page it sits on.
  test('a code per row on every Error-Codes page; a repeated code gathers rows', () => {
    expect(corpus.codes.map((piece) => piece.code)).toEqual(['X_A', 'X_B', 'X_DB_DRIFT', 'X_R']);
    const a = corpus.codes.find((piece) => piece.code === 'X_A');
    expect(a?.rows.map((row) => row.section)).toEqual([
      { title: 'Error codes: @ultimat3/core', url: '/error-codes-core' },
      { title: 'Error codes: @ultimat3/db', url: '/error-codes-db' },
    ]);
    expect(a?.rows[0]?.cells).toEqual([
      { label: 'Means', markdown: 'two at once' },
      { label: 'Typical cause', markdown: 'either \\| both' },
      { label: 'Fix', markdown: 'see [reserved](/error-codes#reserved-codes)' },
    ]);
    const drift = corpus.codes.find((piece) => piece.code === 'X_DB_DRIFT');
    expect(drift?.rows[0]?.cells[1]?.markdown).toBe('a column [moved](/getting-started#install)');
    const reserved = corpus.codes.find((piece) => piece.code === 'X_R');
    expect(reserved?.rows[0]?.section).toEqual({
      title: 'Reserved codes',
      url: '/error-codes#reserved-codes',
    });
  });

  test('an owner page keeps Code | Means, linked; other rows stay as written', () => {
    const db = page('/error-codes-db').markdown;
    expect(db).toContain('| Code | Means |\n|---|---|\n| [`X_A`](/errors/X_A) | again |');
    expect(db).toContain('| [`X_DB_DRIFT`](/errors/X_DB_DRIFT) | schema differs |');
    const core = page('/error-codes-core').markdown;
    expect(core).toContain('| [`X_A`](/errors/X_A) / [`X_B`](/errors/X_B) | two at once |');
    expect(core).toContain('| plain | not a code | x | y |');
  });

  // The index's generated table names each code PLAIN (so no gate counts it as a row): the site
  // keeps every column and links the code to its page.
  test('the index links each plain code to its page and keeps its owner-page column', () => {
    const index = page('/error-codes').markdown;
    expect(index).toContain(
      '| Code | Means | Page |\n|---|---|---|\n| [`X_DB_DRIFT`](/errors/X_DB_DRIFT) | schema differs | [db](/error-codes-db) |',
    );
    expect(index).toContain('| `X_NOT_A_ROW` | a rule table row stays |');
    expect(index).toContain('| Code | Means |\n|---|---|\n| [`X_R`](/errors/X_R) | reserved |');
  });
});

describe('readCorpus · refusals', () => {
  const withGuide = (markdown: string) =>
    readCorpus(
      [...WIKI.filter((one) => one !== GUIDE), { file: GUIDE.file, markdown }],
      FIXTURE_OPTIONS,
    );

  test('a link to no page is X_DOCS_LINK_DEAD naming the wiki line', () => {
    try {
      withGuide('# G\n\nLead.\n\n[x](Nowhere)');
      expect.unreachable('a dead page link built');
    } catch (error) {
      expect(DocsLinkDeadError.is(error)).toBe(true);
      expect(String((error as Error).message)).toContain('wiki/Getting-Started.md:5');
    }
  });

  test('a link to no heading is X_DOCS_LINK_DEAD too, and a code cell is held the same', () => {
    expect(() => withGuide('# G\n\nLead. [x](Upgrading#nope)')).toThrow(/X_DOCS_LINK_DEAD|nope/);
    const codes = {
      file: 'Error-Codes.md',
      markdown: '# E\n\nLead.\n\n| Code | Means | Fix |\n|---|---|---|\n| `X_Q` | q | [x](FAQ) |',
    };
    expect(() => readCorpus([codes], FIXTURE_OPTIONS)).toThrow(/FAQ/);
  });

  // The index's plain codes link to `/errors/<CODE>`, a URL only a row builds: a code listed there
  // with no row on any page would be a 404 the build printed, so it stops the build instead.
  test('an index code no page has a row for is X_DOCS_LINK_DEAD', () => {
    const index = {
      file: 'Error-Codes.md',
      markdown: '# E\n\nLead.\n\n| Code | Means | Page |\n|---|---|---|\n| X_GONE | gone | x |',
    };
    expect(() => readCorpus([index], FIXTURE_OPTIONS)).toThrow(/X_GONE/);
  });

  test('a page with a second # heading is X_DOCS_SECOND_TITLE', () => {
    expect(() => withGuide('# G\n\nLead.\n\n# Again')).toThrow(
      expect.objectContaining({ code: 'X_DOCS_SECOND_TITLE' }),
    );
  });

  test('a page with no prose line is X_DOCS_LEAD_EMPTY', () => {
    expect(() => withGuide('# G\n\n## Only a heading')).toThrow(
      expect.objectContaining({ code: 'X_DOCS_LEAD_EMPTY' }),
    );
  });

  test('a piece past the renderer cap is X_DOCS_PIECE_OVERSIZE, never plain text', () => {
    try {
      readCorpus(WIKI, { ...FIXTURE_OPTIONS, maxChars: 40 });
      expect.unreachable('an oversize piece built');
    } catch (error) {
      expect(DocsPieceOversizeError.is(error)).toBe(true);
    }
  });
});
