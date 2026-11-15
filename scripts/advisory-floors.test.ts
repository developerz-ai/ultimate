import { describe, expect, test } from 'bun:test';
import type { AdvisoryFetch } from './advisory-floors';
import { advisoryFloorsResult, declarationsOf, loadWorld } from './advisory-floors';
import type { Declaration } from './lib/advisory-floors';

// The shell around `lib/advisory-floors.ts`: which declarations it audits, what it asks the two
// services, and the findings `.github/workflows/security-channel.yml` turns into a PR or an issue.

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const PACKUMENTS: Readonly<Record<string, unknown>> = {
  'solid-js': {
    versions: {
      '1.9.17': { dependencies: { seroval: '~1.6.8' } },
      '1.9.18': { dependencies: { seroval: '~1.6.11' } },
    },
  },
  seroval: { versions: { '1.6.8': {}, '1.6.11': {} } },
  sass: {
    versions: {
      '1.106.1': { dependencies: { immutable: '^5.1.5', 'source-map-js': '>=0.6.2 <2.0.0' } },
    },
  },
  immutable: { versions: { '5.1.5': {}, '5.1.9': {} } },
  'source-map-js': { versions: { '1.2.1': {}, '1.2.2': {} } },
};

const advisory = (id: string, name: string, range: string): unknown => ({
  ghsa_id: id,
  withdrawn_at: null,
  vulnerabilities: [{ package: { name }, vulnerable_version_range: range }],
});

const ADVISORIES: Readonly<Record<string, unknown[]>> = {
  immutable: [advisory('GHSA-xvcm-6775-5m9r', 'immutable', '>= 5.0.0-beta.1, < 5.1.8')],
  'source-map-js': [advisory('GHSA-68fv-2mgg-jv7q', 'source-map-js', '>= 1.0.0, < 1.2.2')],
  seroval: [
    {
      ghsa_id: 'GHSA-f86p-h4j2-7qgj',
      withdrawn_at: null,
      vulnerabilities: [
        { package: { name: 'seroval' }, vulnerable_version_range: '>= 1.6.0, < 1.6.11' },
      ],
    },
  ],
};

const asked: string[] = [];
const fetcher: AdvisoryFetch = async (url) => {
  asked.push(url);
  const parsed = new URL(url);
  if (parsed.hostname === 'registry.npmjs.org') {
    const body = PACKUMENTS[decodeURIComponent(parsed.pathname.slice(1))];
    return body === undefined ? new Response('', { status: 404 }) : json(body);
  }
  return json(ADVISORIES[parsed.searchParams.get('affects') ?? ''] ?? []);
};

const solidPeer: Declaration = {
  manifest: 'packages/ui/package.json',
  field: 'peerDependencies',
  name: 'solid-js',
  range: '^1.9.0',
};

describe('declarationsOf', () => {
  test('audits external dependencies and peers, never a sibling or a dev tool', () => {
    const declarations = declarationsOf('packages/ui/package.json', {
      dependencies: { '@ultimat3/core': '31.27.0', sass: '1.106.1', local: 'workspace:*' },
      peerDependencies: { 'solid-js': '^1.9.0' },
      devDependencies: { typescript: '^7.0.2' },
    });
    expect(declarations.map((d) => `${d.field}.${d.name}@${d.range}`)).toEqual([
      'dependencies.sass@1.106.1',
      'peerDependencies.solid-js@^1.9.0',
    ]);
  });
});

describe('advisoryFloorsResult', () => {
  test('a transitive advisory through a peer becomes a raise the workflow can apply', async () => {
    const loaded = await loadWorld([solidPeer], fetcher, undefined);
    const result = advisoryFloorsResult([solidPeer], loaded);
    expect(result.ok).toBe(false);
    expect(result.findings?.[0]).toMatchObject({
      code: 'X_ADVISORY_RANGE_OPEN',
      at: 'packages/ui/package.json peerDependencies.solid-js',
      fix: 'bun run scripts/advisory-floors.ts --write',
    });
    expect(result.data).toMatchObject({
      raises: [{ name: 'solid-js', from: '^1.9.0', to: '^1.9.18' }],
    });
    // The dependency's dependencies are asked about too: that is where the advisory was.
    expect(asked.some((url) => url.includes('affects=seroval'))).toBe(true);
  });

  test('an advisory no release of the dependency floors names every package an app updates', async () => {
    const sass: Declaration = {
      manifest: 'packages/render/package.json',
      field: 'dependencies',
      name: 'sass',
      range: '1.106.1',
    };
    const result = advisoryFloorsResult([sass], await loadWorld([sass], fetcher, undefined));
    expect(result.raises).toEqual([]);
    expect(result.findings?.[0]).toMatchObject({
      code: 'X_ADVISORY_UNFLOORABLE',
      fix: 'bun update immutable source-map-js',
    });
  });

  test('a dependency of a dependency that does not answer leaves the range unjudged', async () => {
    const partial: AdvisoryFetch = async (url, init) =>
      url.includes('affects=seroval') ? new Response('', { status: 503 }) : fetcher(url, init);
    const result = advisoryFloorsResult(
      [solidPeer],
      await loadWorld([solidPeer], partial, undefined),
    );
    expect(result.findings?.map((f) => f.code)).toEqual(['X_ADVISORY_UNREACHABLE']);
  });

  test('a registry that does not answer is a finding, never a clean audit', async () => {
    const down: AdvisoryFetch = async () => new Response('', { status: 503 });
    const loaded = await loadWorld([solidPeer], down, undefined);
    const result = advisoryFloorsResult([solidPeer], loaded);
    expect(result.ok).toBe(false);
    expect(result.findings?.map((f) => f.code)).toContain('X_ADVISORY_UNREACHABLE');
  });
});
