/**
 * Recipes from a folder of markdown, one file per recipe, its body served verbatim. The file name
 * is the recipe's name; an optional `---` block sets `title:` and `description:`, else the first
 * `# ` heading and the first paragraph do. Its steps are its ```call fences — `tool {json}` — so
 * the boot check holds a markdown recipe to the catalog exactly as a structured one.
 */

// why: Bun exposes no path-join primitive; the folder is the app's.
import { join } from 'node:path';
import { McpRecipeExampleInvalidError } from './recipe-errors';
import type { McpRecipe, McpRecipeStep } from './recipes';

/** A whole-string `"<name>"` in a fenced call: a value `replay` substitutes, any value at boot. */
export const PLACEHOLDER = /^<([A-Za-z][\w-]*)>$/;

const FENCE = /^```call[^\S\n]*\n([\s\S]*?)\n```[^\S\n]*$/gm;

/** Every `*.md` under `dir`, sorted by name: the same folder is the same recipes, in order. */
export async function markdownRecipes(input: { readonly dir: string }): Promise<McpRecipe[]> {
  const files = [...new Bun.Glob('*.md').scanSync({ cwd: input.dir })].sort();
  const recipes: McpRecipe[] = [];
  for (const file of files) {
    const text = await Bun.file(join(input.dir, file)).text();
    recipes.push(recipeFromMarkdown(file.replace(/\.md$/, ''), text));
  }
  return recipes;
}

/** One file's recipe. A fenced call that does not parse is refused naming the file and fence. */
export function recipeFromMarkdown(name: string, text: string): McpRecipe {
  const { fields, body } = frontMatter(text.replace(/\r\n/g, '\n'));
  const lines = body.split('\n');
  const heading = lines
    .find((line) => line.startsWith('# '))
    ?.slice(2)
    .trim();
  const paragraph = firstParagraph(lines);
  return {
    name,
    title: fields.get('title') ?? heading ?? name,
    description: fields.get('description') ?? paragraph ?? '',
    steps: fencedCalls(name, body),
    body: body.trim() === '' ? '' : `${body.trim()}\n`,
  };
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
