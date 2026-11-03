// `x docs Upgrading#28x--2900-entry-by-entry` — a wiki topic, answered with its WHOLE section. A
// search hit carries a capped excerpt; an agent moving one major needs every entry of that major,
// and the 386 kB page it lives on is the thing it must not have to read.

// why: Bun ships no path module; the page is joined onto the wiki directory the CLI resolved.
import { join } from 'node:path';
import { wikiSection } from '@ultimat3/manifest';
import type { WikiSource } from './docs-sources';
import { msg } from './messages';
import type { CommandResult } from './output';

/**
 * `Upgrading#anchor` or `wiki.Upgrading#anchor`. The page is a bare file stem — no `/`, no `.` —
 * so the topic can only ever name a file directly inside the wiki directory.
 */
const WIKI_TOPIC = /^(?:wiki\.)?([A-Za-z0-9][A-Za-z0-9-]*)#([^\s#/]+)$/;

export interface WikiTopic {
  readonly page: string;
  readonly anchor: string;
}

export function parseWikiTopic(query: string): WikiTopic | undefined {
  const match = WIKI_TOPIC.exec(query);
  if (match === null) return undefined;
  return { page: match[1] ?? '', anchor: match[2] ?? '' };
}

/**
 * The section, or `undefined` when the page or the anchor is not in this install — the caller then
 * answers as for any question, so a stale anchor still ends in the nearest topics.
 */
export async function sectionResult(
  wiki: WikiSource,
  topic: WikiTopic,
  query: string,
): Promise<CommandResult | undefined> {
  if (topic.page === 'Error-Codes') return undefined;
  const file = Bun.file(join(wiki.dir, `${topic.page}.md`));
  if (!(await file.exists())) return undefined;
  const text = wikiSection(await file.text(), topic.anchor);
  if (text === undefined) return undefined;
  const id = `wiki.${topic.page}#${topic.anchor}`;
  return {
    ok: true,
    command: 'docs',
    summary: msg('cli.docs.found', { count: 1, query }),
    // The page's own prose, verbatim: quoted source, not this command's wording.
    lines: text.split('\n').map((line) => `  ${line}`),
    data: {
      matches: [
        {
          topic: id,
          package: '@ultimat3/cli',
          version: wiki.version,
          kind: 'guide',
          title: text.split('\n')[0]?.replace(/^#+\s*/, '') ?? '',
          text,
          symbols: [],
          source: `${wiki.relative}/${topic.page}.md`,
          matched: [],
          score: 0,
        },
      ],
      suggestions: [],
      query,
    },
  };
}
