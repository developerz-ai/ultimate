// The viewers' one structural promise, held by the source: no viewer, parser or renderer writes an
// HTML string into the DOM, so a body from a model can only ever become text nodes. A future
// "faster" path through `innerHTML` fails here, by name, before a review has to notice it.

import { expect, test } from 'bun:test';

const SRC = Bun.fileURLToPath(new URL('..', import.meta.url));

/** Every module a viewer renders through — the components and the whole `content/` tree. */
const VIEWERS = [
  'components/Markdown.tsx',
  'components/markdown-nodes.tsx',
  'components/CodeBlock.tsx',
  'components/JsonView.tsx',
  'components/json-view-view.ts',
  'components/DiffView.tsx',
  'components/diff-view-view.ts',
  'components/LogViewer.tsx',
  'components/log-viewer-view.ts',
  'components/TerminalView.tsx',
];

const SINKS =
  /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bdangerouslySetInnerHTML\b|\bcreateContextualFragment\b|\bDOMParser\b|document\.write/;

test('no viewer source names an HTML sink', async () => {
  const content = [...new Bun.Glob('content/**/*.ts').scanSync({ cwd: SRC })].filter(
    (file) => !file.endsWith('.test.ts'),
  );
  // Not vacuous: the parsers are in the list.
  expect(content).toContain('content/markdown-parse.ts');
  const offenders: string[] = [];
  for (const file of [...VIEWERS, ...content]) {
    const source = await Bun.file(`${SRC}${file}`).text();
    const found = SINKS.exec(source);
    if (found !== null) offenders.push(`${file}: ${found[0]}`);
  }
  expect(offenders).toEqual([]);
});
