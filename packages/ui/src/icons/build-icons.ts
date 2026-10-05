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

/** Where one pinned version's node table lives. */
export const iconNodesUrl = (version: string): string =>
  `https://cdn.jsdelivr.net/npm/lucide-static@${version}/icon-nodes.json`;

export const LUCIDE_ICON_NODES_URL = iconNodesUrl(LUCIDE_VERSION);

/** The registry's answer for the newest published `lucide-static` — what `--bump` pins to. */
export const LUCIDE_LATEST_URL = 'https://registry.npmjs.org/lucide-static/latest';

/** The tail of every cause about data the PIN published: why re-running alone cannot help. */
const PIN_REPEATS = `lucide-static@${LUCIDE_VERSION} is the pin that published it, so a re-run against the same pin repeats this; \`--bump\` raises LUCIDE_VERSION in packages/ui/src/icons/build-icons.ts to the latest release and regenerates`;

export const GLYPHS_DIR = Bun.fileURLToPath(new URL('./glyphs/', import.meta.url));

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
  const parsed = parseJson(text);
  // `typeof [] === 'object'`, and an array of icons is a different upstream format, not this one.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidIconDataError(
      `parsed as ${renderCauseValue(parsed)}, not the object of name to nodes that icon-nodes.json publishes; ${LUCIDE_ICON_NODES_URL} served something else`,
      'bun run --filter @ultimat3/ui icons',
    );
  }
  const out = new Map<string, IconGlyph>();
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    // Checked BEFORE the map holds it: the key reaches three sinks downstream — a filesystem path,
    // a TypeScript identifier and a `//` banner — and `buildIcons` clears GLYPHS_DIR before it
    // writes, so `../../index` is a delete plus an overwrite of a hand-written module.
    if (!SAFE_ICON_NAME.test(name)) {
      throw invalidIconDataError(
        `carries ${renderCauseValue(name)} as an icon name, which is not the kebab-case shape every Lucide icon uses; the name becomes a file path and an exported identifier, so it cannot be escaped. ${PIN_REPEATS}`,
        'bun run --filter @ultimat3/ui icons --bump',
      );
    }
    out.set(name, toGlyph(name, value));
  }
  return out;
}

/** The body as JSON, or the same coded refusal a wrong shape gets — never a bare `SyntaxError`. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw invalidIconDataError(
      `is not JSON (${renderCauseValue(text.slice(0, 80))}…); ${LUCIDE_ICON_NODES_URL} served an error page or a truncated body`,
      'bun run --filter @ultimat3/ui icons',
    );
  }
}

/** A node that is not `[tag, attrs?]` with an object for attrs — refused, never skipped. */
function malformedNode(name: string, node: unknown): ReturnType<typeof invalidIconDataError> {
  return invalidIconDataError(
    `for the icon "${name}" carries ${renderCauseValue(node)} where a [tag, attributes] node belongs; skipping it would write a partial glyph. ${PIN_REPEATS}`,
    'bun run --filter @ultimat3/ui icons --bump',
  );
}

const isAttrs = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * An icon name, as characters: lowercase kebab-case, no leading, trailing or doubled hyphen. The
 * same allowlist-over-a-sink shape as `SAFE_ATTR_VALUE`, one layer up — the name is interpolated
 * into a PATH and an IDENTIFIER, neither of which has an escape, so refusing is the only move.
 * Measured against the whole committed set: all 1767 names pass (`build-icons.test.ts` asserts it).
 */
export const SAFE_ICON_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Glyph geometry, as characters: digits, the path-command letters, `currentColor`/`none`, and the
 * separators between them. Deliberately not "anything that is not a quote" — an allowlist over a
 * value bound for a code sink is the only shape that stays correct when the sink changes.
 */
export const SAFE_ATTR_VALUE = /^[\w\s.,+-]*$/;

function toGlyph(name: string, value: unknown): IconGlyph {
  const glyph: (readonly [string, Readonly<Record<string, string>>])[] = [];
  if (!Array.isArray(value)) throw malformedNode(name, value);
  for (const node of value as unknown[]) {
    if (!Array.isArray(node) || typeof node[0] !== 'string') throw malformedNode(name, node);
    const rawAttrs: unknown = node[1] ?? {};
    if (!isAttrs(rawAttrs)) throw malformedNode(name, node);
    const attrs: Record<string, string> = {};
    for (const [key, item] of Object.entries(rawAttrs)) {
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
          `for the icon "${name}" carries ${renderCauseValue(text)} as "${key}", which is not glyph geometry; ${PIN_REPEATS}`,
          'bun run --filter @ultimat3/ui icons --bump',
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
      `for the icon "${name}" carries no renderable node data; ${PIN_REPEATS}`,
      'bun run --filter @ultimat3/ui icons --bump',
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
  const biome = Bun.fileURLToPath(new URL('../../../../node_modules/.bin/biome', import.meta.url));
  if (!(await Bun.file(biome).exists())) {
    throw runtimeMissingError('the biome binary', 'bun install');
  }
  // A formatter over one directory of generated files; a wedged one is the refusal below.
  const result = Bun.spawnSync([biome, 'format', '--write', GLYPHS_DIR], { timeout: 60_000 });
  if (result.exitCode !== 0) {
    throw runtimeMissingError(
      'a successful `biome format` over the generated glyphs',
      'bunx biome format --write packages/ui/src/icons/glyphs',
    );
  }
}

export async function buildIcons(version: string = LUCIDE_VERSION): Promise<number> {
  const response = await fetch(iconNodesUrl(version));
  if (!response.ok) {
    throw runtimeMissingError(
      `lucide-static@${version} icon data (HTTP ${response.status} from ${iconNodesUrl(version)})`,
      'bun run --filter @ultimat3/ui icons',
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

/** A plain `major.minor.patch` — the only shape allowed into a TypeScript string literal here. */
const SEMVER = /^\d+\.\d+\.\d+$/;

/** `source` with its `LUCIDE_VERSION` line moved to `version`. Pure; refuses rather than guesses. */
export function withPin(source: string, version: string): string {
  if (!SEMVER.test(version)) {
    throw invalidIconDataError(
      `answered ${renderCauseValue(version)} as the latest lucide-static version, which is not plain semver; ${LUCIDE_LATEST_URL} served something else`,
      'bun run --filter @ultimat3/ui icons --bump',
    );
  }
  const pin = /^export const LUCIDE_VERSION = '[^']*';$/m;
  if (!pin.test(source)) {
    throw invalidIconDataError(
      'has no `export const LUCIDE_VERSION = …` line in packages/ui/src/icons/build-icons.ts to move',
      'git checkout -- packages/ui/src/icons/build-icons.ts',
    );
  }
  return source.replace(pin, `export const LUCIDE_VERSION = '${version}';`);
}

/** Moves the pin to the registry's latest release, in this very file, and answers the version. */
async function bumpPin(): Promise<string> {
  const response = await fetch(LUCIDE_LATEST_URL);
  if (!response.ok) {
    throw runtimeMissingError(
      `the latest lucide-static version (HTTP ${response.status} from ${LUCIDE_LATEST_URL})`,
      'bun run --filter @ultimat3/ui icons --bump',
    );
  }
  const body: unknown = await response.json();
  const version =
    typeof body === 'object' && body !== null && 'version' in body ? String(body.version) : '';
  const file = import.meta.path;
  await Bun.write(file, withPin(await Bun.file(file).text(), version));
  return version;
}

if (import.meta.main) {
  const version = Bun.argv.includes('--bump') ? await bumpPin() : LUCIDE_VERSION;
  const count = await buildIcons(version);
  const json = { ok: true, icons: count, lucide: version, dir: GLYPHS_DIR };
  console.log(Bun.argv.includes('--json') ? JSON.stringify(json) : `${count} icon modules written`);
}
