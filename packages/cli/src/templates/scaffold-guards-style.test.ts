// What holds the seven stylesheet guards to the framework that ships them. A guard is a file an
// app owns, so nothing else checks these four things: that the scales a guard embeds are the
// token package's, that the framework's OWN sheets pass the rules it hands to apps, that both
// tracked apps carry exactly what `x new` writes, and that `x g guard <name>` reaches each one.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API; `mkdtemp`/`rm` own a throwaway root's lifetime.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { generate } from '../generate-files';
import { guardSources } from '../guard-sources';
import type { Guard } from '../guards';
import type { Finding } from '../output';
import { guardFiles } from './guard';
import { SHIPPED_GUARD_NAMES, scaffoldGuardFiles, shippedGuardFiles } from './scaffold-guards';

const REPO = Bun.fileURLToPath(new URL('../../../..', import.meta.url)).replace(/[\\/]$/, '');
const TOKENS = `${REPO}/packages/ui/src/tokens`;

/** The five that read a stylesheet as text; the two that compile one are held by their own tests. */
const TEXT_GUARDS = ['raw-breakpoint', 'raw-length', 'raw-motion', 'raw-shadow', 'raw-z-index'];

/** The emitted guard modules, imported from a throwaway root — as the gate imports them. */
async function withEmitted<T>(
  body: (load: (name: string) => Promise<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'x-guard-style-'));
  try {
    for (const file of scaffoldGuardFiles()) {
      if (!file.path.endsWith('.test.ts')) await Bun.write(join(root, file.path), file.contents);
    }
    return await body((name) => import(join(root, `guards/${name}.ts`)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A flat `$name: ( key: value, … );` map out of a token partial, as written. */
async function scssMap(
  file: string,
  name: string,
): Promise<readonly (readonly [string, string])[]> {
  const source = await Bun.file(`${TOKENS}/${file}`).text();
  const block = new RegExp(`\\$${name}:\\s*\\(([\\s\\S]*?)\\n\\);`).exec(source)?.[1];
  if (block === undefined) return expect.unreachable(`${file} declares no $${name} map`);
  return block
    .split('\n')
    .map((line) => line.trim().replace(/,$/, ''))
    .filter((line) => line.includes(':'))
    .map((line) => [
      line.slice(0, line.indexOf(':')).trim(),
      line.slice(line.indexOf(':') + 1).trim(),
    ]);
}

const px = (value: string): number => Number(value.replace(/px$/, ''));

describe("unit · shipped guards · the scales a guard embeds are the token package's", () => {
  test('space, stroke, breakpoints, z, durations and easings match their SCSS partials', async () => {
    await withEmitted(async (load) => {
      const length = await load('raw-length');
      // rem → px at the 16px root `rem()` itself assumes; `0` is not a length anyone rewrites.
      const space = (await scssMap('_space.scss', 'space'))
        .filter(([, value]) => value !== '0')
        .map(([step, value]) => [String(Number(value.replace(/rem$/, '')) * 16), step]);
      expect(length['SPACE']).toEqual(Object.fromEntries(space));
      // The hairline is the one stroke the rule never reports, so it has no rewrite.
      const stroke = (await scssMap('_stroke.scss', 'stroke'))
        .filter(([name]) => name !== 'hairline')
        .map(([name, value]) => [String(px(value)), name]);
      expect(length['STROKE']).toEqual(Object.fromEntries(stroke));

      expect((await load('raw-breakpoint'))['RUNGS']).toEqual(
        (await scssMap('_breakpoints.scss', 'breakpoints')).map(([name, value]) => [
          name,
          px(value),
        ]),
      );
      expect((await load('raw-z-index'))['LAYERS']).toEqual(
        (await scssMap('_z.scss', 'z')).map(([name, value]) => [name, Number(value)]),
      );
      const motion = await load('raw-motion');
      expect(motion['DURATIONS']).toEqual(
        (await scssMap('_motion.scss', 'duration')).map(([name, value]) => [
          name,
          Number(value.replace(/ms$/, '')),
        ]),
      );
      expect(motion['EASINGS']).toEqual(
        Object.fromEntries(
          (await scssMap('_motion.scss', 'easing')).map(([name, value]) => [
            value.replace(/^cubic-bezier\(|\)$/g, '').replaceAll(' ', ''),
            name,
          ]),
        ),
      );
    });
  });
});

describe('unit · shipped guards · the framework passes the rules it ships', () => {
  /**
   * The helpers a rule sends an author TO are defined somewhere, and that somewhere is these two
   * partials: `rem()` / `fluid()`, and the three breakpoint mixins with the `@media` each one
   * wraps. Pinned as an exact list, so the exemption cannot quietly grow a ninth line.
   */
  const DEFINITIONS: readonly string[] = [
    'X_RAW_BREAKPOINT respond-between',
    'X_RAW_BREAKPOINT respond-down',
    'X_RAW_BREAKPOINT respond-to',
    'X_RAW_BREAKPOINT @media',
    'X_RAW_BREAKPOINT @media',
    'X_RAW_BREAKPOINT @media',
    'X_RAW_LENGTH fluid()',
    'X_RAW_LENGTH rem()',
  ];

  const isDefinition = (finding: Finding): boolean =>
    /^packages\/ui\/src\/tokens\/_(?:mixins|units)\.scss:/.test(finding.at ?? '') &&
    / defines its own |@media \(/.test(finding.cause);

  const label = (finding: Finding): string =>
    `${finding.code} ${/defines its own ([\w()-]+)/.exec(finding.cause)?.[1] ?? '@media'}`;

  test('every stylesheet in packages/ui is clean under the five text rules', async () => {
    const findings = await withEmitted(async (load) => {
      const sources = guardSources(REPO);
      // The glob every one of them asks for; an empty walk would pass all five by reading nothing.
      expect((await sources.files('{apps,packages}/**/*.scss')).length).toBeGreaterThan(60);
      const all: Finding[] = [];
      for (const name of TEXT_GUARDS) {
        const guard = (await load(name))['guard'] as Guard;
        all.push(...(await guard.check(REPO, sources)));
      }
      return all;
    });
    expect(
      findings.filter((finding) => !isDefinition(finding)).map((f) => `${f.at} ${f.fix}`),
    ).toEqual([]);
    expect(findings.filter(isDefinition).map(label).sort()).toEqual([...DEFINITIONS].sort());
  });
});

describe('unit · shipped guards · both tracked apps carry the set `x new` writes', () => {
  for (const app of ['examples/dummy', 'dummy/social-media-clone']) {
    test(`${app}/guards is byte-identical to the templates`, async () => {
      const drifted: string[] = [];
      for (const file of scaffoldGuardFiles()) {
        const onDisk = Bun.file(`${REPO}/${app}/${file.path}`);
        if (!(await onDisk.exists())) drifted.push(`${file.path}: absent`);
        else if ((await onDisk.text()) !== file.contents) drifted.push(`${file.path}: differs`);
      }
      // A guard edited in place is a rule this app and `x new` disagree about: the repair goes in
      // the template and comes back through `x g guard <name> --force`.
      expect(drifted).toEqual([]);
    });
  }
});

describe('unit · x g guard · a shipped name is the shipped guard', () => {
  test('every shipped name is reachable, and writes exactly what `x new` writes for it', () => {
    expect(SHIPPED_GUARD_NAMES).toHaveLength(17);
    for (const name of SHIPPED_GUARD_NAMES) {
      const written = generate({ kind: 'guard', name });
      expect(written).toEqual(shippedGuardFiles(name) ?? []);
      expect(written.map((file) => file.path)).toEqual([
        `guards/${name}.ts`,
        `guards/${name}.test.ts`,
      ]);
    }
  });

  test('the name is read the way every generator reads one', () => {
    expect(generate({ kind: 'guard', name: 'RawLength' })).toEqual(
      shippedGuardFiles('raw-length') ?? [],
    );
  });

  test("any other name is still the blank template — the app's own convention", () => {
    expect(generate({ kind: 'guard', name: 'migration-safety' })).toEqual(
      guardFiles('migration-safety'),
    );
    expect(shippedGuardFiles('migration-safety')).toBeUndefined();
  });
});
