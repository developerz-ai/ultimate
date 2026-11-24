/**
 * Recipes from a folder of markdown, one file per recipe, body as written (LF line ends, outer
 * blank lines trimmed): file name = name, a
 * sub-folder = section, `---` sets `title:`/`description:`/`aliases:` (else heading, paragraph).
 * Its ```call fences — `tool {json}` — are its steps, boot-checked like a structured recipe's.
 */

// why: Bun exposes no path-join primitive; `sep` says whether `\` separates paths here.
import { join, sep } from 'node:path';
import { McpRecipeExampleInvalidError } from './recipe-errors';
import type { McpRecipe, McpRecipeStep } from './recipes';

/** A whole-string `"<name>"` in a fenced call: a value `replay` substitutes, any value at boot. */
export const PLACEHOLDER = /^<([A-Za-z][\w-]*)>$/;

const FENCE = /^```call[^\S\n]*\n([\s\S]*?)\n```[^\S\n]*$/gm;

/**
 * Every `*.md` in `dir` (section `recipes`), then every `<section>/*.md` one folder down, each
 * sorted by path: the same folder is the same recipes, in order. `recipes/<name>.md` and
 * `<name>.md` are one URI. A folder name that is not lowercase letters and digits in
 * `-`-separated groups is refused at boot, like a name. The file opened is the path the glob
 * returned: on POSIX `\` is a file-name character, so only Windows' separator is normalised.
 */
export async function markdownRecipes(input: { readonly dir: string }): Promise<McpRecipe[]> {
  const top = [...new Bun.Glob('*.md').scanSync({ cwd: input.dir })].sort();
  const nested = [...new Bun.Glob('*/*.md').scanSync({ cwd: input.dir })].sort();
  const recipes: McpRecipe[] = [];
  for (const file of [...top, ...nested]) {
    const text = await Bun.file(join(input.dir, file)).text();
    const path = sep === '\\' ? file.replaceAll('\\', '/') : file;
    const slash = path.indexOf('/');
    const name = path.slice(slash + 1).replace(/\.md$/, '');
    recipes.push(
      slash === -1
        ? recipeFromMarkdown(name, text)
        : recipeFromMarkdown(name, text, path.slice(0, slash)),
    );
  }
  return recipes;
}

/** One file's recipe. A fenced call that does not parse is refused naming the file and fence. */
export function recipeFromMarkdown(name: string, text: string, section?: string): McpRecipe {
  const { fields, body } = frontMatter(text.replace(/\r\n/g, '\n'));
  const lines = body.split('\n');
  const heading = lines
    .find((line) => line.startsWith('# '))
    ?.slice(2)
    .trim();
  const paragraph = firstParagraph(lines);
  const aliases = fields.get('aliases');
  return {
    name,
    ...(section === undefined ? {} : { section }),
    ...(aliases === undefined ? {} : { aliases: aliasList(aliases) }),
    title: fields.get('title') ?? heading ?? name,
    description: fields.get('description') ?? paragraph ?? '',
    steps: fencedCalls(name, body),
    body: withoutOuterBlankLines(body),
  };
}

/** Whole blank lines only: a content line's own spaces are Markdown (an indented code block). */
function withoutOuterBlankLines(body: string): string {
  const lines = body.split('\n');
  // Spaces and tabs only: a no-break space is content.
  const blank = (line: string | undefined) => line !== undefined && /^[ \t]*$/.test(line);
  while (blank(lines[0])) lines.shift();
  while (blank(lines.at(-1))) lines.pop();
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function frontMatter(text: string): {
  readonly fields: ReadonlyMap<string, string>;
  readonly body: string;
} {
  const fields = new Map<string, string>();
  if (!text.startsWith('---\n')) return { fields, body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { fields, body: text };
  for (const line of text.slice(4, end).split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return { fields, body: text.slice(end + 5) };
}

/** `aliases: refund, money back` or `aliases: [refund, "money, back"]`: a quoted comma stays. */
function aliasList(value: string): readonly string[] {
  const entries: string[] = [];
  let entry = '';
  let quote: string | undefined;
  for (const char of value.replace(/^\[(.*)\]$/, '$1')) {
    if (quote === undefined && char === ',') {
      entries.push(entry);
      entry = '';
      continue;
    }
    // A quote opens only at an entry's start: `customer's invoice` is one plain alias.
    if (char === quote) quote = undefined;
    else if (quote === undefined && (char === '"' || char === "'") && entry.trim() === '') {
      quote = char;
    }
    entry += char;
  }
  entries.push(entry);
  return entries
    .map((alias) => alias.trim().replace(/^(["'])(.*)\1$/, '$2'))
    .filter((alias) => alias !== '');
}

function firstParagraph(lines: readonly string[]): string | undefined {
  const start = lines.findIndex(
    (line) => line.trim() !== '' && !line.startsWith('#') && !line.startsWith('```'),
  );
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && line.trim() === '');
  return lines
    .slice(start, end === -1 ? undefined : end)
    .join(' ')
    .trim();
}

/** ```call fences: `tool` then an optional JSON object, which may span lines. */
function fencedCalls(name: string, body: string): McpRecipeStep[] {
  const steps: McpRecipeStep[] = [];
  const offenders: string[] = [];
  let index = 0;
  for (const match of body.matchAll(FENCE)) {
    index += 1;
    const content = (match[1] ?? '').trim();
    const space = content.search(/\s/);
    const tool = space === -1 ? content : content.slice(0, space);
    const rest = space === -1 ? '' : content.slice(space).trim();
    const example = rest === '' ? {} : parseObject(rest);
    if (tool === '' || example === undefined) {
      offenders.push(
        `recipe "${name}" call fence ${String(index)}: write \`tool {"arg": "value"}\``,
      );
      continue;
    }
    steps.push({ tool, why: `fenced call ${String(index)}`, example });
  }
  if (offenders.length > 0) throw new McpRecipeExampleInvalidError({ offenders });
  return steps;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    // Not JSON: the caller names the fence.
    return undefined;
  }
}

/** Paths (validate-args' spelling) whose value is a whole `"<name>"` placeholder. */
export function placeholderPaths(value: unknown, path = ''): readonly string[] {
  if (typeof value === 'string') return PLACEHOLDER.test(value) ? [path] : [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => placeholderPaths(item, `${path}[${String(index)}]`));
  }
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    placeholderPaths(item, path === '' ? key : `${path}.${key}`),
  );
}

/** `"<postId>"` → `placeholders.get('postId')`; a placeholder with no value stays as written. */
export function fillPlaceholders(
  value: unknown,
  placeholders: ReadonlyMap<string, unknown>,
): unknown {
  if (typeof value === 'string') {
    const key = PLACEHOLDER.exec(value)?.[1];
    return key !== undefined && placeholders.has(key) ? placeholders.get(key) : value;
  }
  if (Array.isArray(value)) return value.map((item) => fillPlaceholders(item, placeholders));
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(out, key, {
      value: fillPlaceholders(item, placeholders),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
