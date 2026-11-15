import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { reportDoctor } from './cmd-doctor';
import { probe } from './cmd-doctor-fixture';
import { SUPERSEDED_WORKAROUND, supersededFindings } from './doctor-superseded';
import { SUPERSEDED_WORKAROUNDS } from './superseded';

/** One app holding every row's workaround, each where an app keeps it. */
const WORKAROUNDS: Readonly<Record<string, { readonly path: string; readonly text: string }>> = {
  'ssr-until-hole': {
    path: 'apps/web/app/dashboard/page.tsx',
    text: [
      "import { defineRoute } from '@ultimat3/render';",
      'export const config = defineRoute({',
      "  // 'ssr', not 'stream': the framework has no hole marker yet.",
      "  render: 'ssr',",
      '});',
    ].join('\n'),
  },
  'token-unimplemented': {
    path: 'apps/web/app/api-keys/mint-cli.ts',
    text: '// Mints a key by hand: `x token` is not implemented.\nexport const mint = 1;\n',
  },
  'verify-no-only': {
    path: 'docs/framework/gaps.md',
    text: '# Gaps\n\n- the gate has no `--only`, so CI runs every step\n',
  },
  'dev-no-tls': {
    path: 'bin/serve-https.ts',
    text: '// x dev cannot serve https on the LAN, so this terminates TLS.\nBun.serve({});\n',
  },
};

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function app(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'x-superseded-'));
  roots.push(root);
  await Bun.write(join(root, 'app.config.ts'), 'export default {};\n');
  for (const [path, text] of Object.entries(files)) await Bun.write(join(root, path), text);
  return root;
}

describe('unit · x doctor superseded workarounds', () => {
  test('the fixture holds one workaround per table row: a new row needs its example', () => {
    expect(Object.keys(WORKAROUNDS).sort()).toEqual(
      SUPERSEDED_WORKAROUNDS.map((row) => row.id).sort(),
    );
  });

  test('each workaround is one warning, at its file, with the row fix', async () => {
    const root = await app(
      Object.fromEntries(Object.values(WORKAROUNDS).map(({ path, text }) => [path, text])),
    );
    const findings = await supersededFindings(root);
    const byAt = new Map(findings.map((finding) => [finding.at, finding]));
    expect(findings).toHaveLength(SUPERSEDED_WORKAROUNDS.length);
    for (const row of SUPERSEDED_WORKAROUNDS) {
      const at = WORKAROUNDS[row.id]?.path ?? '';
      const finding = byAt.get(at);
      expect(finding?.code).toBe(SUPERSEDED_WORKAROUND);
      expect(finding?.fix).toBe(row.fix);
      expect(finding?.cause).toContain(`'${row.id}'`);
      expect(finding?.cause).toContain(row.shippedIn);
    }
  });

  test('an app with none of them reports nothing', async () => {
    const root = await app({
      'apps/web/app/dashboard/page.tsx': "export const config = { render: 'ssr' };\n",
      'README.md': 'Run `x verify --only lint` and `x token create`.\n',
    });
    expect(await supersededFindings(root)).toEqual([]);
  });

  test('vendored copies are never read', async () => {
    const hit = WORKAROUNDS['verify-no-only'];
    const root = await app({ 'docs/node_modules/pkg/gaps.md': hit?.text ?? '' });
    expect(await supersededFindings(root)).toEqual([]);
  });

  test('x doctor reports them beside the verdict, never in it', async () => {
    const token = WORKAROUNDS['token-unimplemented'];
    const root = await app({ [token?.path ?? '']: token?.text ?? '' });
    const result = await reportDoctor(probe({ root }));
    const findings = (result.findings ?? []).map((finding) => finding.code);
    expect(findings).not.toContain(SUPERSEDED_WORKAROUND);
    const data = result.data as { readonly warnings?: readonly { readonly code: string }[] };
    expect(data.warnings?.map((warning) => warning.code)).toContain(SUPERSEDED_WORKAROUND);
  });
});
