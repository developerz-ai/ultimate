// The registry audit across a support window (wiki/Stability.md): a tree stamped at an older
// major is audited against its `maint-<major>` tag, never `latest`, and every `maint-*` tag the
// packument carries must name its own major, attested. Split from `registry-audit.test.ts`.

import { describe, expect, test } from 'bun:test';
import {
  auditRegistry,
  packumentUrl,
  type RegistryFetch,
  registryFindings,
} from './registry-audit';

const attested = {
  dist: { attestations: { url: 'https://x/att' } },
  _npmUser: { name: 'GitHub Actions' },
};
const handPublished = { dist: {}, _npmUser: { name: 'someone' } };

const serve =
  (tags: Record<string, string>, versions: Record<string, unknown>): RegistryFetch =>
  (url) =>
    Promise.resolve(
      url === packumentUrl('@ultimat3/core')
        ? new Response(JSON.stringify({ 'dist-tags': tags, versions }))
        : new Response('{}', { status: 404 }),
    );

const audit = async (version: string, fetcher: RegistryFetch) =>
  registryFindings(await auditRegistry([{ name: '@ultimat3/core', version }], fetcher));

describe('unit · registry-audit · maint-29 beside latest', () => {
  test('a 29.x tree is clean when maint-29 names it, whatever latest is', async () => {
    const fetcher = serve(
      { latest: '30.2.0', 'maint-29': '29.4.1' },
      { '29.4.1': attested, '30.2.0': attested },
    );
    expect(await audit('29.4.1', fetcher)).toEqual([]);
  });

  test('a 29.x tree whose maint-29 is behind is drift on maint-29, not on latest', async () => {
    const fetcher = serve(
      { latest: '30.2.0', 'maint-29': '29.4.0' },
      { '29.4.0': attested, '29.4.1': attested, '30.2.0': attested },
    );
    const [finding, ...rest] = await audit('29.4.1', fetcher);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_REGISTRY_LATEST_DRIFT');
    expect(finding?.fix).toContain('npm dist-tag add @ultimat3/core@29.4.1 maint-29');
  });

  test('the current tree audits latest, and each maint-* tag beside it', async () => {
    const clean = serve(
      { latest: '30.2.0', 'maint-29': '29.4.1' },
      { '29.4.1': attested, '30.2.0': attested },
    );
    expect(await audit('30.2.0', clean)).toEqual([]);
    const wrongMajor = serve(
      { latest: '30.2.0', 'maint-29': '30.1.0' },
      { '30.1.0': attested, '30.2.0': attested },
    );
    expect((await audit('30.2.0', wrongMajor)).map((finding) => finding.code)).toEqual([
      'X_REGISTRY_LATEST_DRIFT',
    ]);
    const unattested = serve(
      { latest: '30.2.0', 'maint-29': '29.4.1' },
      { '29.4.1': handPublished, '30.2.0': attested },
    );
    const [finding] = await audit('30.2.0', unattested);
    expect(finding?.code).toBe('X_REGISTRY_UNATTESTED');
    expect(finding?.cause).toContain('29.4.1');
  });
});
