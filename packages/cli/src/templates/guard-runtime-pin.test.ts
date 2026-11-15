// The `runtime-pin` guard as `x new` emits it, run through the gate's own seam: a fresh scaffold
// passes it, and each pin site that names a different Bun than `engines.bun` is refused at its line
// with the text to write there. The rule's own cases ship beside it, in the app.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory, symlink or mkdir API; `node:fs/promises` is the only one.
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { REQUIRED_BUN } from '../app-root';
import { planNewApp } from '../cmd-new';
import { SCAFFOLD_BUN_IMAGE } from './bun-image';
import { runtimePinGuardFiles } from './guard-runtime-pin';
import { runtimePinReport } from './runtime-pin-fixture';

const CODE = 'X_RUNTIME_PIN';
const PIN_PATHS = /^(?:package\.json|\.bun-version|\.github\/.+\.ya?ml|docker\/Dockerfile.*)$/;

/** The pin sites of a fresh `x new`, as text. */
const scaffoldPins = (): Record<string, string> => {
  const pins: Record<string, string> = {};
  for (const file of planNewApp({ name: 'pin-app', example: false })) {
    if (PIN_PATHS.test(file.path) && typeof file.contents === 'string') {
      pins[file.path] = file.contents;
    }
  }
  return pins;
};

const report = runtimePinReport;

const lineOf = (text: string, needle: string): number =>
  text.split('\n').findIndex((line) => line.includes(needle)) + 1;

const ENGINES = `{ "name": "a", "engines": { "bun": ">=${REQUIRED_BUN}" } }\n`;

describe('unit · shipped guard · runtime-pin', () => {
  test('a fresh scaffold names one Bun everywhere, and the guard says nothing', async () => {
    const pins = scaffoldPins();
    // A pin set the scaffold stopped writing would pass by reading nothing.
    expect(Object.keys(pins)).toContain('docker/Dockerfile');
    expect(Object.keys(pins)).toContain('.github/workflows/ci.yml');
    expect(Object.keys(pins)).toContain('package.json');
    expect(await report(pins)).toEqual({ findings: [], warnings: [] });
  });

  test('a CI bun-version off engines.bun is refused at its line, with the line to write', async () => {
    const pins = scaffoldPins();
    const ci = pins['.github/workflows/ci.yml'] ?? '';
    const line = lineOf(ci, 'bun-version:');
    pins['.github/workflows/ci.yml'] = ci.replaceAll(
      `bun-version: '${REQUIRED_BUN}'`,
      "bun-version: '1.4.3'",
    );
    const { findings } = await report(pins);
    expect(findings.map((finding) => finding.code)).toEqual([CODE, CODE, CODE]);
    expect(findings[0]?.at).toBe(`.github/workflows/ci.yml:${line}`);
    expect(findings[0]?.cause).toContain('1.4.3');
    expect(findings[0]?.fix).toStartWith(
      `edit .github/workflows/ci.yml:${line} — bun-version: '${REQUIRED_BUN}'`,
    );
  });

  test('a FROM with no digest is refused, and the fix pastes the scaffold image', async () => {
    const dockerfile = `FROM oven/bun:${SCAFFOLD_BUN_IMAGE.series}-alpine AS deps\n`;
    const { findings } = await report({ 'package.json': ENGINES, 'docker/Dockerfile': dockerfile });
    expect(findings.map((finding) => finding.at)).toEqual(['docker/Dockerfile:1']);
    expect(findings[0]?.fix).toStartWith(
      `edit docker/Dockerfile:1 — FROM ${SCAFFOLD_BUN_IMAGE.ref} AS deps`,
    );
  });

  test('an image series, or a recorded digest patch, off engines.bun is refused', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const dockerfile = [
      "# The digest is `oven/bun:1.4.3-alpine`'s, the patch it was read from.",
      `FROM oven/bun:1.3-alpine@${digest} AS deps`,
      `FROM oven/bun:${SCAFFOLD_BUN_IMAGE.series}-alpine@${digest} AS runtime`,
      '',
    ].join('\n');
    const { findings } = await report({ 'package.json': ENGINES, 'docker/Dockerfile': dockerfile });
    expect(findings.map((finding) => finding.at)).toEqual([
      'docker/Dockerfile:1',
      'docker/Dockerfile:2',
    ]);
    expect(findings[1]?.fix).toContain(`FROM ${SCAFFOLD_BUN_IMAGE.ref} AS deps`);
  });

  test('a version the scaffold has no digest for is asked of the registry, by name', async () => {
    const { findings } = await report({
      'package.json': '{ "engines": { "bun": ">=1.9.1" } }\n',
      'docker/Dockerfile': `FROM ${SCAFFOLD_BUN_IMAGE.ref} AS deps\n`,
    });
    expect(findings[0]?.fix).toStartWith(
      'edit docker/Dockerfile:1 — FROM oven/bun:1.9-alpine@<digest> AS deps, the digest from: docker buildx imagetools inspect oven/bun:1.9.1-alpine',
    );
  });

  test('.bun-version, packageManager and a floating `latest` are pins too', async () => {
    const { findings } = await report({
      'package.json': `{\n  "packageManager": "bun@1.4.1",\n  "engines": { "bun": ">=${REQUIRED_BUN}" }\n}\n`,
      '.bun-version': '1.4.5\n',
      '.github/workflows/ci.yml':
        'jobs:\n  a:\n    steps:\n      - with:\n          bun-version: latest\n',
    });
    expect(findings.map((finding) => finding.at)).toEqual([
      '.bun-version:1',
      '.github/workflows/ci.yml:5',
      'package.json:2',
    ]);
    expect(findings[0]?.fix).toStartWith(`edit .bun-version:1 — ${REQUIRED_BUN}`);
    expect(findings[2]?.fix).toStartWith(
      `edit package.json:2 — "packageManager": "bun@${REQUIRED_BUN}"`,
    );
  });

  test('no engines.bun is refused: the version every other pin is read against', async () => {
    const { findings } = await report({ 'package.json': '{ "name": "a" }\n' });
    expect(findings.map((finding) => finding.at)).toEqual(['package.json:1']);
    expect(findings[0]?.fix).toStartWith(
      `edit package.json:1 — "engines": { "bun": ">=${REQUIRED_BUN}" }`,
    );
  });

  test('a series, an expression, a version file and a comment agree or are not read', async () => {
    const workflow = [
      'jobs:',
      '  a:',
      '    steps:',
      '      - with:',
      `          bun-version: ${SCAFFOLD_BUN_IMAGE.series}.x`,
      '      - with:',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub expression, written as text.
      '          bun-version: ${{ matrix.bun }}',
      '      - with:',
      '          bun-version-file: .bun-version',
      "      # bun-version: '1.0.0' was the pin once",
      '',
    ].join('\n');
    const dockerfile = [
      '# FROM oven/bun:1.0-alpine was the base once',
      'ARG BUN=1.4',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a Dockerfile build arg, written as text.
      'FROM oven/bun:${BUN}-alpine AS deps',
      `FROM ${SCAFFOLD_BUN_IMAGE.ref} AS runtime`,
      '',
    ].join('\n');
    expect(
      await report({
        'package.json': ENGINES,
        '.github/workflows/ci.yml': workflow,
        'docker/Dockerfile': dockerfile,
      }),
    ).toEqual({ findings: [], warnings: [] });
  });

  test('ships its own test beside the rule', () => {
    expect(runtimePinGuardFiles().map((file) => file.path)).toEqual([
      'guards/runtime-pin.ts',
      'guards/runtime-pin.test.ts',
    ]);
  });
  test('the test it ships beside the rule passes in an app', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-guard-runtime-pin-test-'));
    try {
      for (const file of runtimePinGuardFiles())
        await Bun.write(join(root, file.path), file.contents);
      await mkdir(join(root, 'node_modules/@ultimat3'), { recursive: true });
      for (const pkg of ['testing', 'cli']) {
        const target = Bun.fileURLToPath(new URL(`../../../${pkg}`, import.meta.url));
        await symlink(target, join(root, `node_modules/@ultimat3/${pkg}`));
      }
      const run = Bun.spawnSync(['bun', 'test', './guards/runtime-pin.test.ts'], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const said = run.stderr.toString();
      expect(said, said).toContain(' 4 pass');
      expect(run.exitCode, said).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
