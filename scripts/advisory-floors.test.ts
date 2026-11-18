import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdvisoryFetch } from './advisory-floors';
import {
  ADVISORY_API,
  ADVISORY_FETCH_WIDTH,
  advisoryFloorsResult,
  declarationsOf,
  loadWorld,
  lockedVersions,
} from './advisory-floors';
import type { Declaration, ResolvedVersions } from './lib/advisory-floors';

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

/** What this checkout's `bun.lock` resolves, past every advisory it reaches. */
const CLEAN: Readonly<Record<string, readonly string[]>> = {
  sass: ['1.106.1'],
  immutable: ['5.1.9'],
  'source-map-js': ['1.2.2'],
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

  test('a lockfile past every advisory holds it: listed in data.locked, never a finding', async () => {
    const sass: Declaration = {
      manifest: 'packages/render/package.json',
      field: 'dependencies',
      name: 'sass',
      range: '1.106.1',
    };
    const resolved: ResolvedVersions = (name) => CLEAN[name];
    const result = advisoryFloorsResult(
      [sass],
      await loadWorld([sass], fetcher, undefined),
      resolved,
    );
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.data).toMatchObject({
      raises: [],
      locked: [
        {
          manifest: 'packages/render/package.json',
          field: 'dependencies',
          name: 'sass',
          range: '1.106.1',
          resolved: { immutable: ['5.1.9'], 'source-map-js': ['1.2.2'] },
        },
      ],
    });
    expect(result.summary).toContain('1 held by bun.lock');
  });

  test('a lockfile still resolving an advised version keeps the range red', async () => {
    const sass: Declaration = {
      manifest: 'packages/render/package.json',
      field: 'dependencies',
      name: 'sass',
      range: '1.106.1',
    };
    const resolved: ResolvedVersions = (name) => (name === 'immutable' ? ['5.1.7'] : CLEAN[name]);
    const result = advisoryFloorsResult(
      [sass],
      await loadWorld([sass], fetcher, undefined),
      resolved,
    );
    expect(result.ok).toBe(false);
    expect(result.locked).toEqual([]);
    expect(result.data).toMatchObject({ locked: [] });
    expect(result.findings?.[0]).toMatchObject({
      code: 'X_ADVISORY_UNFLOORABLE',
      fix: 'bun update immutable source-map-js',
    });
  });

  test('no lockfile read at all keeps the same range red, and lists nothing as held', async () => {
    const sass: Declaration = {
      manifest: 'packages/render/package.json',
      field: 'dependencies',
      name: 'sass',
      range: '1.106.1',
    };
    const result = advisoryFloorsResult([sass], await loadWorld([sass], fetcher, undefined));
    expect(result.ok).toBe(false);
    expect(result.locked).toEqual([]);
    expect(result.summary).not.toContain('held by bun.lock');
    expect(result.findings?.[0]).toMatchObject({ code: 'X_ADVISORY_UNFLOORABLE' });
  });

  test('a lockfile missing an exposed package holds nothing', async () => {
    const sass: Declaration = {
      manifest: 'packages/render/package.json',
      field: 'dependencies',
      name: 'sass',
      range: '1.106.1',
    };
    const partial: ResolvedVersions = (name) =>
      name === 'source-map-js'
        ? CLEAN['source-map-js']
        : name === 'sass'
          ? CLEAN['sass']
          : undefined;
    const result = advisoryFloorsResult(
      [sass],
      await loadWorld([sass], fetcher, undefined),
      partial,
    );
    expect(result.ok).toBe(false);
    expect(result.locked).toEqual([]);
    expect(result.findings?.[0]).toMatchObject({ code: 'X_ADVISORY_UNFLOORABLE' });
  });

  test('every held declaration is counted in the summary', async () => {
    const held = (manifest: string): Declaration => ({
      manifest,
      field: 'dependencies',
      name: 'sass',
      range: '1.106.1',
    });
    const declarations = [held('packages/render/package.json'), held('packages/ui/package.json')];
    const result = advisoryFloorsResult(
      declarations,
      await loadWorld(declarations, fetcher, undefined),
      (name) => CLEAN[name],
    );
    expect(result.ok).toBe(true);
    expect(result.locked.map((l) => l.manifest)).toEqual([
      'packages/render/package.json',
      'packages/ui/package.json',
    ]);
    expect(result.summary).toContain('2 held by bun.lock');
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

describe('lockedVersions', () => {
  test('reads every copy a package resolves, nested ones included, and nothing else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-locked-versions-'));
    await Bun.write(
      join(root, 'bun.lock'),
      [
        '{',
        '  "lockfileVersion": 1,',
        '  "packages": {',
        '    "sass": ["sass@1.107.1", "", {}],',
        '    "immutable": ["immutable@5.1.9", "", {}],',
        '    "other/immutable": ["immutable@5.1.7", "", {}],',
        '    "left-pad": ["left-pad@1.0.0", "", {}],',
        '  },',
        '}',
        '',
      ].join('\n'),
    );
    const resolved = await lockedVersions(root);
    await rm(root, { recursive: true, force: true });
    expect(resolved?.('immutable')).toEqual(['5.1.9', '5.1.7']);
    expect(resolved?.('sass')).toEqual(['1.107.1']);
    expect(resolved?.('seroval')).toEqual([]);
  });

  test('a checkout with no lockfile closes nothing, rather than closing everything', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-locked-versions-'));
    expect(await lockedVersions(root)).toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });

  test('an unparsable lockfile closes nothing either: a read in part is not a read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-locked-versions-'));
    await Bun.write(join(root, 'bun.lock'), '{ "packages": { "sass": ["sass@1.107.1", \n');
    const resolved = await lockedVersions(root);
    await rm(root, { recursive: true, force: true });
    expect(resolved).toBeUndefined();
  });

  test('a lockfile entry that names no version is never read as one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-locked-versions-'));
    await Bun.write(
      join(root, 'bun.lock'),
      [
        '{',
        '  "packages": {',
        '    "sass": ["sass@1.107.1"],',
        '    "immutable": ["", {}],',
        '  },',
        '}',
        '',
      ].join('\n'),
    );
    const resolved = await lockedVersions(root);
    await rm(root, { recursive: true, force: true });
    expect(resolved?.('sass')).toEqual(['1.107.1']);
    expect(resolved?.('immutable')).toEqual([]);
  });
});

describe('loadWorld, against the advisory API', () => {
  const linked = (body: unknown, next: string | undefined): Response =>
    new Response(JSON.stringify(body), {
      headers: {
        'content-type': 'application/json',
        ...(next === undefined ? {} : { link: `<${next}>; rel="next", <${next}>; rel="last"` }),
      },
    });

  test('follows rel="next": an advisory on the second page is still read', async () => {
    const page2 = `${ADVISORY_API}?ecosystem=npm&per_page=100&affects=seroval&page=2`;
    const paged: AdvisoryFetch = async (url, init) => {
      if (url === page2) return json(ADVISORIES['seroval']);
      if (url.startsWith(ADVISORY_API) && url.includes('affects=seroval')) return linked([], page2);
      return fetcher(url, init);
    };
    const result = advisoryFloorsResult(
      [solidPeer],
      await loadWorld([solidPeer], paged, undefined),
    );
    expect(result.raises.map((r) => r.to)).toEqual(['^1.9.18']);
  });

  test('a next page on another host is never followed with the token: the range is unjudged', async () => {
    const asked: string[] = [];
    const elsewhere: AdvisoryFetch = async (url, init) => {
      asked.push(url);
      if (url.startsWith(ADVISORY_API) && url.includes('affects=seroval')) {
        return linked([], 'https://evil.example/advisories?page=2');
      }
      return fetcher(url, init);
    };
    const result = advisoryFloorsResult(
      [solidPeer],
      await loadWorld([solidPeer], elsewhere, 'token'),
    );
    expect(result.findings?.map((f) => f.code)).toEqual(['X_ADVISORY_UNREACHABLE']);
    expect(asked.some((url) => new URL(url).hostname === 'evil.example')).toBe(false);
  });

  test('a list with pages past the cap is unjudged, never read as complete', async () => {
    let page = 0;
    const endless: AdvisoryFetch = async (url, init) => {
      if (url.startsWith(ADVISORY_API) && url.includes('affects=seroval')) {
        page += 1;
        return linked([], `${ADVISORY_API}?ecosystem=npm&affects=seroval&page=${page + 1}`);
      }
      return fetcher(url, init);
    };
    const result = advisoryFloorsResult(
      [solidPeer],
      await loadWorld([solidPeer], endless, undefined),
    );
    expect(result.findings?.map((f) => f.code)).toEqual(['X_ADVISORY_UNREACHABLE']);
  });

  test(`never more than ${ADVISORY_FETCH_WIDTH} packages in flight at once`, async () => {
    let inFlight = 0;
    let peak = 0;
    const slow: AdvisoryFetch = async (url) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return url.startsWith(ADVISORY_API) ? json([]) : json({ versions: { '1.0.0': {} } });
    };
    const many: Declaration[] = Array.from({ length: ADVISORY_FETCH_WIDTH * 4 }, (_, i) => ({
      ...solidPeer,
      name: `pkg-${i}`,
      range: '^1.0.0',
    }));
    await loadWorld(many, slow, undefined);
    // Two requests per package: its packument and its advisories, asked together.
    expect(peak).toBeLessThanOrEqual(ADVISORY_FETCH_WIDTH * 2);
    expect(peak).toBeGreaterThan(1);
  });
});
