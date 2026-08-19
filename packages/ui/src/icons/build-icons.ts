// Generates `src/icons/glyphs/<name>.ts` — one module per Lucide icon — from upstream
// `lucide-static` data: `bun run --filter @ultimat3/ui icons`. We wrap Lucide, we do not draw
// icons, so an upstream fix is a version bump plus a re-run and never a hand edit.

import { rm } from 'node:fs/promises';
import { renderCauseValue } from '@ultimat3/core';
import type { IconGlyph } from '../components/icon-glyph';
import { iconElements } from '../components/icon-glyph';
import { invalidIconDataError, runtimeMissingError } from '../errors';

/** Pinned: a floating version would silently redraw icons under an app that never asked. */
export const LUCIDE_VERSION = '1.31.0';

export const LUCIDE_ICON_NODES_URL = `https://cdn.jsdelivr.net/npm/lucide-static@${LUCIDE_VERSION}/icon-nodes.json`;

export const GLYPHS_DIR = new URL('./glyphs/', import.meta.url).pathname;

/** `circle-alert` → `iconCircleAlert`. Prefixed because `delete`, `import` and `package` are icons
 * and reserved words — one uniform rule beats three exceptions an agent has to remember. */
export function identifierFor(name: string): string {
  const pascal = name.replace(/(^|-)(\w)/g, (_, __, letter: string) => letter.toUpperCase());
  return `icon${pascal}`;
}

/**
 * Upstream JSON in, validated glyphs out. `unknown` all the way down — the file is fetched over
 * the network, so its shape is an assumption until it is checked.
 */
export function parseIconNodes(text: string): ReadonlyMap<string, IconGlyph> {
  const parsed: unknown = JSON.parse(text);
  // `typeof [] === 'object'`, and an array of icons is a different upstream format, not this one.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidIconDataError(
      `parsed as ${renderCauseValue(parsed)}, not the object of name to nodes that icon-nodes.json publishes; ${LUCIDE_ICON_NODES_URL} served something else`,
      'bun run --filter @ultimat3/ui icons',
    );
  }
  const out = new Map<string, IconGlyph>();
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    out.set(name, toGlyph(name, value));
  }
  return out;
}

/**
 * Glyph geometry, as characters: digits, the path-command letters, `currentColor`/`none`, and the
 * separators between them. Deliberately not "anything that is not a quote" — an allowlist over a
 * value bound for a code sink is the only shape that stays correct when the sink changes.
 */
export const SAFE_ATTR_VALUE = /^[\w\s.,+-]*$/;

function toGlyph(name: string, value: unknown): IconGlyph {
  const glyph: (readonly [string, Readonly<Record<string, string>>])[] = [];
  for (const node of Array.isArray(value) ? (value as unknown[]) : []) {
    if (!Array.isArray(node) || typeof node[0] !== 'string') continue;
    const attrs: Record<string, string> = {};
    for (const [key, item] of Object.entries((node[1] ?? {}) as Record<string, unknown>)) {
      // Upstream keys an element for its diff tooling; it is not an SVG attribute.
      if (key === 'key') continue;
      const text = String(item);
      // Defence in depth behind `moduleSource`'s escaping: geometry is digits, path commands and
      // separators, so anything else in a value that is about to be written into a TYPESCRIPT
      // module is refused here rather than escaped and shipped. Measured against the whole
      // committed set — all 1767 glyphs pass (`build-icons.test.ts` asserts it), so this rejects
      // no legitimate Lucide artwork.
      if (!SAFE_ATTR_VALUE.test(text)) {
        throw invalidIconDataError(
          `for the icon "${name}" carries ${renderCauseValue(text)} as "${key}", which is not glyph geometry; lucide-static@${LUCIDE_VERSION} is the pin that published it, so a re-run against the same pin repeats this`,
          'bun run --filter @ultimat3/ui icons   # after raising LUCIDE_VERSION in packages/ui/src/icons/build-icons.ts',
        );
      }
      attrs[key] = text;
    }
    glyph.push([node[0], attrs]);
  }
  // The same gate the component applies at render time, applied at generation time: a glyph that
  // would throw in a page is a build failure here instead.
  iconElements(glyph);
  if (glyph.length === 0) {
    throw invalidIconDataError(
      `for the icon "${name}" carries no renderable node data; lucide-static@${LUCIDE_VERSION} is the pin that published it, so a re-run against the same pin repeats this`,
      'bun run --filter @ultimat3/ui icons   # after raising LUCIDE_VERSION in packages/ui/src/icons/build-icons.ts',
    );
  }
  return glyph;
}

/**
 * `JSON.stringify`, never `'${value}'`. The value is network-fetched data on its way into a
 * TypeScript module that every app importing that icon will EXECUTE at import — a code sink, not
 * an attribute sink. A raw quote in the value ends the string literal, and `');` after it starts
 * a statement. `JSON.stringify` escapes quotes, backslashes and control characters, and Biome
 * rewrites the quote style afterwards (`format()` below), so the committed output is unchanged.
 * The key needs no escaping: `iconElements` has already refused every name off the allowlist.
 */
const attrsSource = (attrs: Readonly<Record<string, string>>): string =>
  Object.entries(attrs)
    .map(([key, value]) => `${/^[a-z]+$/.test(key) ? key : `'${key}'`}: ${JSON.stringify(value)}`)
    .join(', ');

/** One module's full text. Biome reformats it afterwards, so the layout here is only a seed. */
export function moduleSource(name: string, glyph: IconGlyph): string {
  const nodes = glyph.map(([tag, attrs]) => `  ['${tag}', { ${attrsSource(attrs)} }],`).join('\n');
  return [
    `// The Lucide "${name}" glyph as data. GENERATED by src/icons/build-icons.ts — do not edit.`,
    `// Icon artwork © Lucide contributors, ISC (see src/icons/LICENSE.lucide).`,
    '',
    "import type { IconGlyph } from '../../components/icon-glyph';",
    '',
    `export const ${identifierFor(name)}: IconGlyph = [`,
    nodes,
    '];',
    '',
  ].join('\n');
}

/** Biome owns formatting in this repo, generated files included — so the generator asks it rather
 * than imitating it, and a regenerated set never shows up as a lint diff. */
async function format(): Promise<void> {
  const biome = new URL('../../../../node_modules/.bin/biome', import.meta.url).pathname;
  if (!(await Bun.file(biome).exists())) {
    throw runtimeMissingError('the biome binary', 'bun install, then re-run this generator');
  }
  const result = Bun.spawnSync([biome, 'format', '--write', GLYPHS_DIR]);
  if (result.exitCode !== 0) {
    throw runtimeMissingError(
      'a successful `biome format` over the generated glyphs',
      `run: ${biome} format --write ${GLYPHS_DIR}`,
    );
  }
}

export async function buildIcons(): Promise<number> {
  const response = await fetch(LUCIDE_ICON_NODES_URL);
  if (!response.ok) {
    throw runtimeMissingError(
      `lucide-static@${LUCIDE_VERSION} icon data (HTTP ${response.status})`,
      `check network access to ${LUCIDE_ICON_NODES_URL}, then re-run: bun run --filter @ultimat3/ui icons`,
    );
  }
  const glyphs = parseIconNodes(await response.text());
  // Cleared first: a renamed upstream icon must disappear, not linger as a second spelling.
  await rm(GLYPHS_DIR, { recursive: true, force: true });
  for (const [name, glyph] of [...glyphs].sort(([a], [b]) => a.localeCompare(b))) {
    await Bun.write(`${GLYPHS_DIR}${name}.ts`, moduleSource(name, glyph));
  }
  await format();
  return glyphs.size;
}

if (import.meta.main) {
  const count = await buildIcons();
  const json = { ok: true, icons: count, lucide: LUCIDE_VERSION, dir: GLYPHS_DIR };
  console.log(Bun.argv.includes('--json') ? JSON.stringify(json) : `${count} icon modules written`);
}
