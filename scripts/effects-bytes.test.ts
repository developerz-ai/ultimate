// What one `@ultimat3/effects` entry costs a browser chunk, measured rather than argued.
//
// Three claims (plan 101, slice 07). (1) A CSS-tier entry is 0 B of JS: its server render carries
// the whole effect, so nothing in its directory may reach for a browser API a hydrated island
// would need — checked on the source, because a component held in a client entry is a client
// cost by construction and the 0 B is what a `site/` page pays when nothing imports it into one.
// (2) Every other entry has a per-entry ceiling on its own minified chunk, built from a one-entry
// island, with `solid-js` left external (the island build dedupes it; it is not this package's).
// (3) `ShaderBackground` pays for the preset it uses and no other: the entry chunk holds no GLSL,
// and each of `mesh`, `grain`, `dots` is its own lazy chunk.
//
// The ceilings are first measurements chosen before the entries landed (`As of 2026-11`): when
// real function costs bytes, raise one WITH the measured number and the reason in the same diff
// (`bun run budget-raises`) — never cut a feature to hold a figure.
//
//   bun test ./scripts/effects-bytes.test.ts

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no path API, and no directory-removal API; the entry must live INSIDE
// packages/effects so module resolution for `@ultimat3/*` walks up from a real package.
import { rm, rmdir } from 'node:fs/promises';
// why: same import, same reason — `relative` keeps the generated specifier honest.
import { dirname, join, relative, resolve } from 'node:path';
import { solidJsxPlugin } from '../packages/cli/src/solid-loader';

const SRC = resolve(import.meta.dir, '..', 'packages', 'effects', 'src');

/** One directory per PROCESS: `afterAll` removes it, and two concurrent runs must not collide. */
const FIXTURE_DIR = join(SRC, '..', '.tmp', `effects-bytes-${process.pid}`);
const TMP_ROOT = dirname(FIXTURE_DIR);

interface Entry {
  /** The component's name, as exported from its module. */
  readonly name: string;
  /** `src/<dir>/<Name>.tsx`. */
  readonly dir: string;
}

/** Server-rendered, animates in CSS, hydrates nothing: 0 B JS. */
const CSS_TIER: readonly Entry[] = [
  { name: 'Aurora', dir: 'aurora' },
  { name: 'GridGlow', dir: 'grid-glow' },
  { name: 'Noise', dir: 'noise' },
  { name: 'GlassSurface', dir: 'glass-surface' },
  { name: 'Shimmer', dir: 'shimmer' },
  { name: 'Marquee', dir: 'marquee' },
  { name: 'TextReveal', dir: 'text-reveal' },
];

/**
 * Enhances in an island: minified JavaScript bytes of the one-entry build, solid external. Assets
 * are not JavaScript and are not counted: `@ultimat3/ui` declares every `.scss` file side-effectful,
 * so a build that reaches its barrel copies ~110 kB of raw component stylesheets beside the chunk,
 * which the island build's style plugin handles and this sum used to add as if it were script.
 *
 * Measured 2026-11-28 with this file's own build, each ceiling the measurement plus ~5%:
 *
 * | Entry | Measured | Where the bytes go |
 * |---|---|---|
 * | GradientOrbs | 18,507 B | ~7 kB is core's `UltimateError` + registry (the prop screen throws `X_EFFECTS_INVALID_VALUE`), plus ui's `inView` and motion gate. Was 25,103 B before `useCssPause` stopped it carrying the canvas mount and frame loop |
 * | MosaicGrid | 23,327 B | the same error floor, `frameLoop`, the Canvas2D mount and its tile function. The WebGL2 mount is no longer inlined (`shader-load.ts`) |
 * | SpotlightCard | under 2,048 B | unchanged |
 * | Tilt | 16,641 B | the error floor, `frameLoop`, `inView` and the pointer wiring |
 * | CountUp | 34,019 B | the error floor plus `@ultimat3/money` and the schema `Money` parse behind `Money`-aware counting |
 *
 * The first ceilings (2–4 kB) were set before any entry existed and could not hold the ~7 kB a
 * coded error costs any island that can throw one. Raise WITH the measured number and the reason.
 */
const ISLAND_CEILING_BYTES: ReadonlyArray<Entry & { readonly ceiling: number }> = [
  { name: 'GradientOrbs', dir: 'gradient-orbs', ceiling: 19_456 },
  { name: 'MosaicGrid', dir: 'mosaic-grid', ceiling: 24_576 },
  { name: 'SpotlightCard', dir: 'spotlight-card', ceiling: 2_048 },
  { name: 'Tilt', dir: 'tilt', ceiling: 17_408 },
  { name: 'CountUp', dir: 'count-up', ceiling: 35_840 },
];

const SHADER = { name: 'ShaderBackground', dir: 'shader-background' } as const;
const SHADER_PRESETS = ['mesh', 'grain', 'dots'] as const;
/**
 * `ShaderBackground`'s own chunk: the component, the preset switch, the effect mount and frame
 * loop, the Canvas2D fallback for all three presets and the grain preset's `Noise` frame — never a
 * shader and never the WebGL2 mount. Measured 2026-11-28: 15,794 B; ceiling +5%. The 3,072 B first
 * guess predates the Canvas2D fallback and the server frame, both of which the tier contract requires.
 */
const SHADER_ENTRY_CEILING_BYTES = 16_640;
/** One preset's lazy chunk: its GLSL, plus the mount when no other chunk shares it. */
const SHADER_PRESET_CEILING_BYTES = 8_192;

/** What a hydrated island needs and a CSS-tier entry therefore may not carry. */
const CLIENT_ONLY =
  /\b(onMount|onCleanup|createEffect|createRenderEffect|requestAnimationFrame|IntersectionObserver|ResizeObserver|addEventListener|frameLoop|inView|shader-mount|effect-canvas)\b/;

const specifier = (entry: Entry): string =>
  relative(FIXTURE_DIR, join(SRC, entry.dir, entry.name)).replaceAll('\\', '/');

async function build(name: string, entry: Entry, splitting: boolean) {
  const file = join(FIXTURE_DIR, `${name}.ts`);
  await Bun.write(
    file,
    [
      `import { ${entry.name} } from '${specifier(entry)}';`,
      `export const held = ${entry.name};`,
      '',
    ].join('\n'),
  );
  const built = await Bun.build({
    entrypoints: [file],
    target: 'browser',
    format: 'esm',
    splitting,
    minify: true,
    external: ['solid-js', 'solid-js/*'],
    plugins: [solidJsxPlugin],
  });
  if (!built.success) {
    expect.unreachable(
      `${entry.name} did not bundle: ${built.logs.map((log) => String(log)).join('; ')}`,
    );
  }
  return Promise.all(
    built.outputs.map(async (output) => {
      const text = await output.text();
      return { kind: output.kind, text, bytes: new TextEncoder().encode(text).byteLength };
    }),
  );
}

afterAll(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
  await rmdir(TMP_ROOT).catch(() => undefined);
});

describe('@ultimat3/effects — CSS-tier entries are 0 B of JS', () => {
  test.each(CSS_TIER.map((entry) => [entry.name, entry] as const))(
    '%s carries no client-only machinery',
    async (_name, entry) => {
      const files = [...new Bun.Glob('*.{ts,tsx}').scanSync({ cwd: join(SRC, entry.dir) })].filter(
        (file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'),
      );
      // Not vacuous: an entry that is not there reads no files and would pass every check below.
      expect(files).toContain(`${entry.name}.tsx`);
      const offenders: string[] = [];
      for (const file of files) {
        const match = CLIENT_ONLY.exec(await Bun.file(join(SRC, entry.dir, file)).text());
        if (match !== null) offenders.push(`${entry.dir}/${file}: ${match[0]}`);
      }
      expect(offenders).toEqual([]);
    },
  );

  test.each(CSS_TIER.map((entry) => [entry.name, entry] as const))(
    '%s retains no canvas, shader or frame-loop module in a browser build',
    async (name, entry) => {
      const outputs = await build(`css-${name}`, entry, false);
      const text = outputs.map((output) => output.text).join('\n');
      expect(text).not.toMatch(/getContext\s*\(|requestAnimationFrame|IntersectionObserver/);
    },
    30_000,
  );
});

describe('@ultimat3/effects — island entries stay under their per-entry ceiling', () => {
  test.each(ISLAND_CEILING_BYTES.map((entry) => [entry.name, entry] as const))(
    '%s',
    async (name, entry) => {
      const outputs = await build(`island-${name}`, entry, false);
      const own = outputs
        .filter((output) => output.kind !== 'asset')
        .reduce((sum, output) => sum + output.bytes, 0);
      // Not vacuous: an empty chunk is under every ceiling.
      expect(own).toBeGreaterThan(0);
      expect(`${entry.name}: ${own} B`).toBe(
        own <= entry.ceiling ? `${entry.name}: ${own} B` : `${entry.name}: <= ${entry.ceiling} B`,
      );
    },
    30_000,
  );
});

describe('@ultimat3/effects — ShaderBackground presets are lazy chunks', () => {
  test('the entry holds no GLSL; each preset is its own chunk under its ceiling', async () => {
    const outputs = await build('shader-background', SHADER, true);
    const entry = outputs.filter((output) => output.kind === 'entry-point');
    expect(entry).toHaveLength(1);
    const main = entry[0];
    if (main === undefined) expect.unreachable('no entry chunk');
    expect(main.text).not.toContain('#version 300 es');
    expect(main.bytes).toBeLessThanOrEqual(SHADER_ENTRY_CEILING_BYTES);

    // One chunk per preset, each carrying its own GLSL and no other preset's: a visitor who asks
    // for `mesh` never downloads `grain`.
    const shaders = outputs.filter(
      (output) => output.kind === 'chunk' && output.text.includes('#version 300 es'),
    );
    expect(shaders.length).toBe(SHADER_PRESETS.length);
    for (const chunk of shaders) {
      expect(chunk.bytes).toBeLessThanOrEqual(SHADER_PRESET_CEILING_BYTES);
      const named = SHADER_PRESETS.filter((preset) => chunk.text.includes(`"${preset}"`));
      expect(named.length).toBeLessThanOrEqual(1);
    }
  }, 30_000);

  test('known gap: an unsplit build (a lone island) inlines every preset into the entry', async () => {
    // Today's behaviour, pinned so the Known-gaps row goes red the day the island bundler splits a
    // lone island: with no splitting Bun inlines each dynamic import(), so all three presets ride.
    const outputs = await build('shader-background-unsplit', SHADER, false);
    expect(outputs.filter((output) => output.kind === 'chunk')).toHaveLength(0);
    const entry = outputs.find((output) => output.kind === 'entry-point');
    if (entry === undefined) expect.unreachable('no entry chunk');
    // A vertex and a fragment program per preset.
    expect(entry.text.split('#version 300 es').length - 1).toBe(2 * SHADER_PRESETS.length);
    for (const preset of SHADER_PRESETS) expect(entry.text).toContain(`"${preset}"`);
  }, 30_000);
});
