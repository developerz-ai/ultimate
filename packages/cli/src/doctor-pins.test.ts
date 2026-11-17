import { describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove; the fixture app needs a scratch directory.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { planNewApp } from './cmd-new';
import { PIN_RANGE, pinProbe, pinRangeFindings } from './doctor-pins';
import { SHAPE_OVERLAYS } from './templates/shapes';
import { readPins } from './upgrade-pins';

const pin = (file: string, name: string, spec: string) => ({ file, name, spec });

describe('unit · x doctor framework pins', () => {
  test('exact pins, prereleases and workspace links are what x new writes, and are not reported', () => {
    const pins = [
      pin('package.json', '@ultimat3/core', '31.14.0'),
      pin('package.json', '@ultimat3/cli', '32.0.0-next.1'),
      pin('apps/web/package.json', '@ultimat3/http', 'workspace:*'),
    ];
    expect(pinRangeFindings({ pins, installed: new Map() })).toEqual([]);
  });

  test('a caret or a tilde is reported once per manifest, with the installed version to write', () => {
    const findings = pinRangeFindings({
      pins: [
        pin('package.json', '@ultimat3/core', '^31.0.0'),
        pin('package.json', '@ultimat3/cli', '~31.4.0'),
        pin('apps/web/package.json', '@ultimat3/core', '31.14.0'),
      ],
      installed: new Map([['@ultimat3/core', '31.14.0']]),
    });
    expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
      [PIN_RANGE, 'package.json'],
    ]);
    // The installed version where there is one, the range's own floor where there is not.
    expect(findings[0]?.fix).toContain('"@ultimat3/core": "31.14.0", "@ultimat3/cli": "31.4.0"');
  });
});

// The framework may not contradict itself: what `x new` writes is what `x doctor` holds an app to.
// A fresh app warned `X_FRAMEWORK_PIN_RANGE` on its own scaffolded `^<version>` — exact pins are
// the one rule (`x upgrade` rewrites every pin it moves exact, and a range is a silent upgrade that
// skips the hop's codemods), so every manifest every shape scaffolds is held to it here.
describe('unit · x new writes the pins x doctor accepts', () => {
  test('no manifest of any scaffold shape pins an @ultimat3/* package as a range', () => {
    const shapes = [undefined, ...Object.keys(SHAPE_OVERLAYS)] as const;
    for (const shape of shapes) {
      const files = planNewApp({
        name: 'pin-demo',
        example: true,
        ...(shape === undefined ? {} : { shape: shape as keyof typeof SHAPE_OVERLAYS }),
      });
      const manifests = files
        .filter((file) => file.path.endsWith('package.json') && typeof file.contents === 'string')
        .map((file) => ({ file: file.path, text: String(file.contents) }));
      expect(manifests.length).toBeGreaterThan(0);
      const findings = pinRangeFindings({ pins: readPins(manifests), installed: new Map() });
      expect(findings.map((finding) => `${shape ?? 'default'}: ${finding.cause}`)).toEqual([]);
    }
  });
});

describe('unit · what a range is', () => {
  // Anything but an exact version or a local link moves on the next install.
  test('a star, an x, a dist-tag, a comparator pair, a hyphen range and an npm alias are ranges', () => {
    const specs = [
      '*',
      'x',
      '31.x',
      'latest',
      'next',
      '>=31 <32',
      '31.0.0 - 31.9.0',
      'npm:@ultimat3/core@^31.0.0',
    ];
    const findings = pinRangeFindings({
      pins: specs.map((spec, i) => pin(`apps/a${i}/package.json`, '@ultimat3/core', spec)),
      installed: new Map([['@ultimat3/core', '31.14.0']]),
    });
    expect(findings.map((finding) => finding.at)).toEqual(
      specs.map((_, i) => `apps/a${i}/package.json`),
    );
    // The alias keeps its target: the exact edit is the alias at the installed version.
    expect(findings.at(-1)?.fix).toContain('"@ultimat3/core": "npm:@ultimat3/core@31.14.0"');
  });

  test('an exact npm alias, file: and link: are not ranges', () => {
    const specs = ['npm:@ultimat3/core@31.14.0', 'file:../core', 'link:@ultimat3/core'];
    const pins = specs.map((spec) => pin('package.json', '@ultimat3/core', spec));
    expect(pinRangeFindings({ pins, installed: new Map() })).toEqual([]);
  });

  test('with nothing installed and no version in the spec, the fix names where to read one', () => {
    const [finding] = pinRangeFindings({
      pins: [pin('package.json', '@ultimat3/core', 'latest')],
      installed: new Map(),
    });
    expect(finding?.fix).toContain('npm view @ultimat3/core version');
    expect(finding?.fix).not.toContain('"@ultimat3/core": ""');
  });
});

describe('unit · the probe', () => {
  // The fix's own edit, applied verbatim, clears the finding.
  test('reads every workspace manifest, and the exact edit clears it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-doctor-pins-'));
    try {
      await Bun.write(
        join(root, 'package.json'),
        JSON.stringify(
          { workspaces: ['apps/*'], dependencies: { '@ultimat3/core': '^31.0.0' } },
          null,
          2,
        ),
      );
      await Bun.write(
        join(root, 'apps/web/package.json'),
        JSON.stringify({ name: 'web', dependencies: { '@ultimat3/core': '31.14.0' } }),
      );
      await Bun.write(
        join(root, 'node_modules/@ultimat3/core/package.json'),
        JSON.stringify({ version: '31.14.0' }),
      );
      const before = pinRangeFindings(await pinProbe(root));
      expect(before.map((finding) => finding.at)).toEqual(['package.json']);
      // At the pin's own line: `{`, `"workspaces": [`, `"apps/*"`, `],`, `"dependencies": {`, then it.
      expect(
        before[0]?.fix.startsWith('edit package.json:6 — write "@ultimat3/core": "31.14.0"'),
      ).toBe(true);
      await Bun.write(
        join(root, 'package.json'),
        JSON.stringify({ workspaces: ['apps/*'], dependencies: { '@ultimat3/core': '31.14.0' } }),
      );
      expect(pinRangeFindings(await pinProbe(root))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a root with no manifest is nothing to judge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-doctor-pins-'));
    try {
      expect((await pinProbe(root)).pins).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
