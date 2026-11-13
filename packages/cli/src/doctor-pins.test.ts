import { describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove; the fixture app needs a scratch directory.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { PIN_RANGE, pinProbe, pinRangeFindings } from './doctor-pins';

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
