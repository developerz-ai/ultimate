// Doc entries read out of an installed package tree, at query time.
//
// WHY NOTHING IS GENERATED HERE
// -----------------------------
// The published artifact IS the source (PUBLISHING.md): `files` ships `src/**` and `README.md`,
// and Bun runs the TypeScript directly. So every doc an agent needs is already inside
// `node_modules` — what was missing is retrieval, not payload. A generated `docs.json` per package
// would be a SECOND copy of bytes the tarball already carries, and a second copy is the thing that
// drifts. Reading the installed source cannot disagree with the installed version, because it is
// the installed version. Same split `agents-md.ts` states: facts are derived, prose is
// human-authored — this module derives, and quotes human prose verbatim. It never writes.

// `node:` by necessity, not habit. Bun exposes no native directory listing: `Bun.Glob` walks a
// pattern and yields matches, while this needs the immediate children of the scope directory —
// including the ones that turn out not to be packages. And Bun ships no path module at all, so
// `basename`/`join` are the only way to build a path without hand-rolling separator handling.
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

export type DocEntryKind = 'module' | 'guide';

export interface DocEntry {
  /** `jobs.retry`, `jobs.README#queues` — stable, derived, and unique within a package. */
  readonly topic: string;
  readonly package: string;
  /**
   * The installed version this entry was read out of. Carried on every entry because a doc an
   * agent cannot date is a doc it cannot distrust — and this is the only staleness signal that
   * matters once the text itself is the installed source.
   */
  readonly version: string;
  readonly kind: DocEntryKind;
  /** First line of the module header, or the heading text. Empty when the module has none. */
  readonly title: string;
  /** The header comment or the section body, verbatim, capped. */
  readonly text: string;
  /** Public export names this module contributes to the package's API. */
  readonly symbols: readonly string[];
  /** Package-relative, so a match names a file an agent can open. */
  readonly source: string;
}

/** Long enough for a 1–4 line header and a short section, short enough to print several. */
const MAX_TEXT = 1_200;

/** Only `README.md` and `CLAUDE.md`: the two files every package is already gated on carrying. */
const GUIDE_FILES = ['README.md', 'CLAUDE.md'] as const;

const clamp = (text: string): string =>
  text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT).trimEnd()}…`;

const read = async (path: string): Promise<string | undefined> => {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : undefined;
};

/**
 * Local re-exports only. `export { t } from '@ultimat3/schema'` is another package's symbol: an
 * entry for it would point at a file this package does not ship, and two packages would claim one
 * topic. The public name is the one after `as` — that is what an importer can actually write.
 */
const RE_EXPORT = /export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(\.[^']+)'/g;

export function parseReExports(indexSource: string): ReadonlyMap<string, readonly string[]> {
  const byModule = new Map<string, string[]>();
  for (const match of indexSource.matchAll(RE_EXPORT)) {
    const module = (match[2] ?? '').replace(/^\.\//, '');
    const names = (match[1] ?? '')
      .split(',')
      .map(
        (raw) =>
          raw
            .trim()
            .split(/\s+as\s+/)
            .at(-1)
            ?.trim() ?? '',
      )
      .filter((name) => name !== '');
    if (names.length === 0) continue;
    const existing = byModule.get(module);
    if (existing === undefined) byModule.set(module, names);
    else existing.push(...names);
  }
  return byModule;
}

/**
 * The 1–4 line header every source file carries (99.8% of them, measured) is the most reliable
 * doc unit in this codebase — far more so than JSDoc, which sits on 42% of public exports and not
 * on `job()` itself. Both comment styles, because both are in use.
 */
export function headerComment(source: string): string {
  const lines = source.split('\n');
  const first = lines[0]?.trimStart() ?? '';
  const out: string[] = [];
  if (first.startsWith('//')) {
    for (const line of lines) {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith('//')) break;
      out.push(trimmed.replace(/^\/\/\s?/, ''));
    }
  } else if (first.startsWith('/*')) {
    for (const line of lines) {
      const trimmed = line.trim();
      out.push(
        trimmed
          .replace(/^\/\*+\s?/, '')
          .replace(/\s?\*+\/$/, '')
          .replace(/^\*\s?/, ''),
      );
      if (trimmed.endsWith('*/')) break;
    }
  }
  // A rule of dashes under a heading is a separator in prose, never a sentence.
  return clamp(
    out
      .join('\n')
      .replace(/^-{3,}$/gm, '')
      .trim(),
  );
}

const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * `##`-and-deeper sections of a human-authored guide, quoted verbatim. This is where a conceptual
 * question ("why is money never a float") finds an answer that no symbol name carries.
 */
export function parseGuideSections(
  markdown: string,
): readonly { readonly heading: string; readonly body: string }[] {
  const sections: { heading: string; body: string[] }[] = [];
  for (const line of markdown.split('\n')) {
    const heading = /^#{2,}\s+(.+?)\s*$/.exec(line);
    if (heading !== null) sections.push({ heading: heading[1] ?? '', body: [] });
    else sections.at(-1)?.body.push(line);
  }
  return sections.map((section) => ({
    heading: section.heading,
    body: clamp(section.body.join('\n').trim()),
  }));
}

/** `@ultimat3/jobs` → `jobs`. An unscoped package (`create-ultimate`) keeps its whole name. */
export const shortName = (packageName: string): string => packageName.split('/').at(-1) ?? '';

async function guideEntries(
  dir: string,
  name: string,
  version: string,
): Promise<readonly DocEntry[]> {
  const entries: DocEntry[] = [];
  // Two `##` sections can carry the same text, and their slugs would then collide into one topic
  // id — silently, which is the failure mode the search's own coverage floor exists to prevent,
  // and a direct contradiction of `DocEntry.topic`'s promise to be unique within a package. No
  // shipped guide collides today; an app's own package is one heading away from it. The suffix
  // follows document order, so the id is still derived and still reproducible.
  const used = new Map<string, number>();
  for (const file of GUIDE_FILES) {
    const markdown = await read(join(dir, file));
    if (markdown === undefined) continue;
    const stem = basename(file, '.md');
    for (const section of parseGuideSections(markdown)) {
      const base = `${shortName(name)}.${stem}#${slug(section.heading)}`;
      const seen = (used.get(base) ?? 0) + 1;
      used.set(base, seen);
      entries.push({
        topic: seen === 1 ? base : `${base}-${seen}`,
        package: name,
        version,
        kind: 'guide',
        title: section.heading,
        text: section.body,
        symbols: [],
        source: file,
      });
    }
  }
  return entries;
}

/**
 * One package tree → its doc entries. A tree with no `package.json` is not a package (npm leaves
 * `.bin` and cache directories inside a scope), and a module `index.ts` names but the tarball does
 * not ship is skipped rather than reported: `files` excludes test helpers on purpose, and an entry
 * pointing at a file the install does not have is exactly the lie this module must not tell.
 */
export async function scanPackageDocs(dir: string): Promise<readonly DocEntry[]> {
  const manifest = await read(join(dir, 'package.json'));
  if (manifest === undefined) return [];
  // A truncated `package.json` is what an interrupted install leaves behind, and it is not a
  // package either — same answer as a directory with none, rather than a `SyntaxError` thrown
  // through `scanInstalledDocs`'s `Promise.all` for every other package to inherit.
  const parsed: unknown = parseJson(manifest);
  if (parsed === undefined) return [];
  // `unknown` + a field-by-field read, never a cast: this JSON is whatever is on disk.
  const field = (key: string): string | undefined => {
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const value: unknown = Reflect.get(parsed, key);
    return typeof value === 'string' ? value : undefined;
  };
  const name = field('name');
  if (name === undefined) return [];
  const version = field('version') ?? '';

  const index = await read(join(dir, 'src/index.ts'));
  const modules: ReadonlyMap<string, readonly string[]> =
    index === undefined ? new Map<string, readonly string[]>() : parseReExports(index);
  const scanned = await Promise.all(
    [...modules].map(async ([module, symbols]) => {
      // `.tsx` before giving up: @ultimat3/ui ships ~40 components as .tsx, and resolving only
      // `.ts` indexed none of them — a shipped command silently blind to a whole package.
      const candidates = [`src/${module}.ts`, `src/${module}.tsx`] as const;
      let source: string | undefined;
      let text: string | undefined;
      for (const candidate of candidates) {
        text = await read(join(dir, candidate));
        if (text !== undefined) {
          source = candidate;
          break;
        }
      }
      if (text === undefined || source === undefined) return undefined;
      const header = headerComment(text);
      return {
        topic: `${shortName(name)}.${module}`,
        package: name,
        version,
        kind: 'module',
        title: header.split('\n')[0] ?? '',
        text: header,
        symbols: [...new Set(symbols)].sort(),
        source,
      } satisfies DocEntry;
    }),
  );
  // Modules sort by topic; guides keep the order they were written in. Sorting a guide's sections
  // alphabetically would reorder an argument its author sequenced on purpose, and prose read out
  // of order is prose an agent has to reassemble. Both halves are deterministic, which is what
  // "two scans of one tree agree" actually requires.
  const moduleEntries = scanned
    .filter((entry) => entry !== undefined)
    .sort((a, b) => a.topic.localeCompare(b.topic));
  return [...moduleEntries, ...(await guideEntries(dir, name, version))];
}

/**
 * Every package under a resolved `@ultimat3` scope directory. Deliberately a directory listing
 * rather than a hardcoded package list: an app installs the subset it uses, this repo has all 29,
 * and a list would answer for packages that are not there.
 */
export async function scanInstalledDocs(scopeDir: string): Promise<readonly DocEntry[]> {
  let names: readonly string[];
  try {
    names = await readdir(scopeDir);
  } catch {
    return [];
  }
  const perPackage = await Promise.all(
    [...names].sort().map(async (name) => {
      try {
        return await scanPackageDocs(join(scopeDir, name));
      } catch {
        // `node_modules` is not a curated tree and it is not stable while an install is running:
        // a file can vanish between `exists()` and `text()`, and a directory can be half-written.
        // One package's tree is worth exactly that package's entries — never the whole answer.
        return [];
      }
    }),
  );
  return perPackage.flat();
}

/** `undefined` rather than a throw. The bytes are whatever is on disk, not something we wrote. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
