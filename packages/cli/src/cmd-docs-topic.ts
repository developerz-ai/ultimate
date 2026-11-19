// `x docs <topic-id>` — the id a search lists, handed back, answered with that topic's BODY. A
// terminal search prints titles; the body existed only under `--json`, cut at the index's excerpt
// length, so an agent opened `node_modules/@ultimat3/<pkg>/README.md` by hand to read one section.

// why: Bun ships no path module; a package's guide is joined onto the scope it was scanned from.
import { join } from 'node:path';
import type { DocEntry } from '@ultimat3/manifest';
import { wikiHeadings } from '@ultimat3/manifest';
import { msg } from './messages';
import type { CommandResult } from './output';

/** `@ultimat3/jobs` → `jobs`: a package's directory under a scope, installed or in this checkout. */
const directoryOf = (entry: DocEntry): string =>
  entry.package.slice(entry.package.indexOf('/') + 1);

/**
 * The whole section `entry` was cut from: its heading, its body and every subsection, to the next
 * heading of the same or a higher level. `undefined` when the file or the heading is not found —
 * the caller then prints the index's own excerpt, which is the same text, shorter.
 */
async function guideSection(
  entry: DocEntry,
  scopes: readonly string[],
): Promise<string | undefined> {
  for (const scope of scopes) {
    const file = Bun.file(join(scope, directoryOf(entry), entry.source));
    if (!(await file.exists())) continue;
    const markdown = await file.text();
    const headings = wikiHeadings(markdown);
    const index = headings.findIndex((heading) => heading.heading === entry.title);
    const start = headings[index];
    if (start === undefined) return undefined;
    const end = headings.slice(index + 1).find((heading) => heading.level <= start.level);
    const lines = markdown.split('\n');
    return lines
      .slice(start.line, end?.line ?? lines.length)
      .join('\n')
      .trimEnd();
  }
  return undefined;
}

/** A module's header comment and what it exports; a guide's section, whole. */
async function bodyOf(entry: DocEntry, scopes: readonly string[]): Promise<string> {
  if (entry.kind === 'guide') return (await guideSection(entry, scopes)) ?? entry.text;
  return entry.text;
}

/** The entry whose topic id IS the query — exact, so a question never lands here by accident. */
export const topicNamed = (entries: readonly DocEntry[], query: string): DocEntry | undefined =>
  entries.find((entry) => entry.topic === query);

/** One topic, answered with its body in the terminal and in `--json` alike. */
export async function topicResult(
  entry: DocEntry,
  scopes: readonly string[],
  query: string,
): Promise<CommandResult> {
  const text = await bodyOf(entry, scopes);
  const exports =
    entry.symbols.length === 0
      ? []
      : ['', `  ${msg('cli.docs.exports', { list: entry.symbols.join(', ') })}`];
  return {
    ok: true,
    command: 'docs',
    summary: msg('cli.docs.found', { count: 1, query }),
    // The package's own prose, verbatim: quoted source, not this command's wording.
    lines: [
      `  ${entry.topic}  ${entry.package}/${entry.source}`,
      '',
      ...text.split('\n').map((line) => `  ${line}`),
      ...exports,
    ],
    data: {
      matches: [
        {
          topic: entry.topic,
          package: entry.package,
          version: entry.version,
          kind: entry.kind,
          title: entry.title,
          text,
          symbols: [...entry.symbols],
          source: entry.source,
          matched: [],
          score: 0,
        },
      ],
      suggestions: [],
      query,
    },
  };
}
