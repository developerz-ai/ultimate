// The runtime-pin codemod over the shapes older scaffolds wrote: a 1.4.2 or 1.4.3 digest, a bare tag,
// a moving `setup-bun@v2`. Each is carried to the pin `x new` writes now, and the result passes the
// shipped `runtime-pin` guard; a pin the app chose itself is left whole and reported with its diff.

import { describe, expect, test } from 'bun:test';
import { REQUIRED_BUN } from '../app-root';
import { SCAFFOLD_BUN_IMAGE } from '../templates/bun-image';
import { SETUP_BUN } from '../templates/github/ci.yml';
import { runtimePinReport } from '../templates/runtime-pin-fixture';
import { memoryCodemodApp } from './codemod';
import { codemod } from './runtime-pin';

const OLD_DIGEST = 'sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f';

/** `docker/Dockerfile` as 27.10.3's scaffold wrote it, the lines that carry a pin. */
const dockerfile = (from: string, patch = '1.4.2'): string =>
  [
    '# The tag names the series for the reader; the digest is what builds.',
    `# The digest is \`oven/bun:${patch}-alpine\`'s, the patch the framework that wrote this file was`,
    '# tested on — the same patch as `engines.bun` in package.json.',
    `FROM ${from} AS manifests`,
    'WORKDIR /app',
    `FROM ${from} AS deps`,
    'FROM deps AS runtime',
    'ENTRYPOINT ["bun", "apps/web/server.ts"]',
    '',
  ].join('\n');

const workflow = (pin: string, uses = SETUP_BUN): string =>
  [
    'jobs:',
    '  verify:',
    '    steps:',
    `      - uses: ${uses}`,
    '        with:',
    '          # engines.bun in package.json, exactly: the oldest Bun this app says it runs on.',
    `          bun-version: ${pin}`,
    '      - run: bun run verify',
    '',
  ].join('\n');

const manifest = (range: string): string =>
  `{\n  "name": "older",\n  "engines": {\n    "bun": "${range}"\n  }\n}\n`;

const olderApp = (): Record<string, string> => ({
  'package.json': manifest('>=1.4.2'),
  '.github/workflows/ci.yml': workflow("'1.4.2'"),
  'docker/Dockerfile': dockerfile(`oven/bun:1.4-alpine@${OLD_DIGEST}`),
});

const guardOver = runtimePinReport;

describe('codemod · runtime-pin', () => {
  test('is a codemod the engine can order', () => {
    expect(codemod.id).toBe('runtime-pin');
    expect(codemod.since).toMatch(/^\d+\.\d+\.\d+$/);
    expect(codemod.summary.length).toBeGreaterThan(0);
  });

  test('a 27.10-era app lands on the pin x new writes now, and the guard passes it', async () => {
    // 27.10.3's pins agree with each other at 1.4.2, so the guard passes them. Raise engines.bun
    // alone — the floor, and nothing else — and every other pin is a disagreement it names.
    expect((await guardOver(olderApp())).findings).toEqual([]);
    const raised = { ...olderApp(), 'package.json': manifest(`>=${REQUIRED_BUN}`) };
    expect((await guardOver(raised)).findings.map((finding) => finding.at)).toEqual([
      '.github/workflows/ci.yml:7',
      'docker/Dockerfile:2',
    ]);
    const before = olderApp();
    const app = memoryCodemodApp({ ...before });
    const result = await codemod.run(app);
    expect(result.skipped).toEqual([]);
    expect([...result.changed].sort()).toEqual([
      '.github/workflows/ci.yml',
      'docker/Dockerfile',
      'package.json',
    ]);
    expect(app.files['docker/Dockerfile']).toBe(
      dockerfile(SCAFFOLD_BUN_IMAGE.ref, SCAFFOLD_BUN_IMAGE.patch),
    );
    expect(app.files['.github/workflows/ci.yml']).toBe(workflow(`'${REQUIRED_BUN}'`));
    expect(app.files['package.json']).toBe(manifest(`>=${REQUIRED_BUN}`));
    expect(await guardOver(app.files)).toEqual({ findings: [], warnings: [] });
  });

  test('run twice, the second run changes nothing', async () => {
    const app = memoryCodemodApp(olderApp());
    await codemod.run(app);
    const after = { ...app.files };
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
    expect(app.files).toEqual(after);
  });

  test('a bare tag gains the digest, and a moving setup-bun ref its commit pin', async () => {
    const app = memoryCodemodApp({
      'package.json': manifest(`>=${REQUIRED_BUN}`),
      '.github/workflows/ci.yml': workflow(`'${REQUIRED_BUN}'`, 'oven-sh/setup-bun@v2'),
      'docker/Dockerfile':
        'FROM oven/bun:1.3-alpine AS deps\nFROM --platform=linux/amd64 oven/bun:1.4.2-alpine\n',
    });
    const result = await codemod.run(app);
    expect(result.skipped).toEqual([]);
    expect(app.files['docker/Dockerfile']).toBe(
      `FROM ${SCAFFOLD_BUN_IMAGE.ref} AS deps\nFROM --platform=linux/amd64 ${SCAFFOLD_BUN_IMAGE.ref}\n`,
    );
    expect(app.files['.github/workflows/ci.yml']).toBe(workflow(`'${REQUIRED_BUN}'`));
  });

  test('a CRLF workflow and Dockerfile (a Windows checkout) are judged, carried, and keep CRLF', async () => {
    const crlf = (text: string): string => text.replaceAll('\n', '\r\n');
    const app = memoryCodemodApp({
      'package.json': manifest(`>=${REQUIRED_BUN}`),
      '.github/workflows/ci.yml': crlf(workflow(`'${REQUIRED_BUN}'`, 'oven-sh/setup-bun@v2')),
      'docker/Dockerfile': crlf('FROM oven/bun:1.3-alpine AS deps\n'),
    });
    const result = await codemod.run(app);
    expect(result.skipped).toEqual([]);
    expect(app.files['.github/workflows/ci.yml']).toBe(crlf(workflow(`'${REQUIRED_BUN}'`)));
    expect(app.files['docker/Dockerfile']).toBe(crlf(`FROM ${SCAFFOLD_BUN_IMAGE.ref} AS deps\n`));
  });

  test('an app-chosen image is left whole and reported with the diff it would have taken', async () => {
    const edited = [
      `FROM oven/bun:1.4-alpine@${OLD_DIGEST} AS deps`,
      'FROM oven/bun:1.4-slim AS runtime',
      '',
    ].join('\n');
    const app = memoryCodemodApp({
      'package.json': manifest(`>=${REQUIRED_BUN}`),
      'docker/Dockerfile': edited,
    });
    const result = await codemod.run(app);
    expect(app.files['docker/Dockerfile']).toBe(edited);
    expect(result.changed).toEqual([]);
    expect(result.skipped.map((skip) => skip.path)).toEqual(['docker/Dockerfile']);
    expect(result.skipped[0]?.reason).toContain('docker/Dockerfile:2');
    expect(result.skipped[0]?.diff).toContain(`-FROM oven/bun:1.4-alpine@${OLD_DIGEST} AS deps`);
    expect(result.skipped[0]?.diff).toContain(`+FROM ${SCAFFOLD_BUN_IMAGE.ref} AS deps`);
  });

  test('a floating CI pin is the app’s: the workflow is left whole and reported', async () => {
    const source = workflow('latest');
    const app = memoryCodemodApp({
      'package.json': manifest(`>=${REQUIRED_BUN}`),
      '.github/workflows/ci.yml': source,
    });
    const result = await codemod.run(app);
    expect(app.files['.github/workflows/ci.yml']).toBe(source);
    expect(result.skipped.map((skip) => skip.path)).toEqual(['.github/workflows/ci.yml']);
    expect(result.skipped[0]?.diff).toContain(`+          bun-version: '${REQUIRED_BUN}'`);
  });

  test('a digest the scaffold never wrote, a newer Bun, a matrix and a current app stay silent', async () => {
    const moved = `sha256:${'e'.repeat(64)}`;
    const files = {
      'package.json': manifest(`>=${REQUIRED_BUN}`),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub expression, written as text.
      '.github/workflows/ci.yml': workflow('${{ matrix.bun }}'),
      '.github/workflows/next.yml': workflow("'9.9.9'"),
      'docker/Dockerfile': `FROM oven/bun:1.4-alpine@${moved} AS deps\nFROM ${SCAFFOLD_BUN_IMAGE.ref}\n`,
    };
    const app = memoryCodemodApp({ ...files });
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
    expect(app.files).toEqual(files);
  });
});
