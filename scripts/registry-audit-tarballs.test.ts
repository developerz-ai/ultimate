// `tarballsServed`: npm answers a version's packument before it serves the version's tarball, so a
// release's `npm-scaffold` read "every package attested" and then 404'd on `http-29.4.0.tgz` (run
// 41214625530). The wait in release.yml polls this too. Network injected, as in every audit test.

import { describe, expect, test } from 'bun:test';
import { jobOf, readWorkflow, text } from './lib/ci-workflow-read';
import type { PublishState, RegistryFetch } from './registry-audit';
import { auditRegistry, tarballsServed } from './registry-audit';

const tarballOf = (name: string): string =>
  `https://registry.npmjs.org/${name}/-/${name.split('/')[1]}-1.0.0.tgz`;

const packument = (name: string): unknown => ({
  'dist-tags': { latest: '1.0.0' },
  versions: { '1.0.0': { dist: { attestations: {}, tarball: tarballOf(name) } } },
});

/** Answers packuments with a 200, and each tarball HEAD with the status `served` gives it. */
const registry =
  (served: (url: string) => number, seen: string[] = []): RegistryFetch =>
  async (url, init) => {
    seen.push(`${init.method ?? 'GET'} ${url}`);
    if (url.endsWith('.tgz')) return new Response(null, { status: served(url) });
    const name = decodeURIComponent(url.slice('https://registry.npmjs.org/'.length));
    return Response.json(packument(name));
  };

const hangUp = new TypeError('socket hang up');

const TARGETS = [
  { name: '@ultimat3/core', version: '1.0.0' },
  { name: '@ultimat3/http', version: '1.0.0' },
];

describe('unit · registry audit · every tarball is served, not only listed', () => {
  test('the packument tarball url is kept on the state', async () => {
    const states = await auditRegistry(
      TARGETS,
      registry(() => 200),
    );
    expect(states.map((state) => state.tarball)).toEqual(TARGETS.map((t) => tarballOf(t.name)));
  });

  test('every tarball answering a HEAD 200 is no finding, and only HEADs are sent', async () => {
    const seen: string[] = [];
    const states = await auditRegistry(
      TARGETS,
      registry(() => 200),
    );
    expect(
      await tarballsServed(
        states,
        registry(() => 200, seen),
      ),
    ).toEqual([]);
    expect(seen).toEqual(TARGETS.map((t) => `HEAD ${tarballOf(t.name)}`));
  });

  test('a listed version whose tarball 404s is the lag, named — never "unpublished"', async () => {
    const states = await auditRegistry(
      TARGETS,
      registry(() => 200),
    );
    const findings = await tarballsServed(
      states,
      registry((url) => (url.includes('/http/') ? 404 : 200)),
    );
    expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_REGISTRY_UNREACHABLE', '@ultimat3/http'],
    ]);
    expect(findings[0]?.cause).toContain('HTTP 404');
    expect(findings[0]?.cause).toContain(tarballOf('@ultimat3/http'));
    expect(findings[0]?.fix).toContain('--tarballs');
  });

  test('a request that throws, or a state with no tarball url, is a finding too', async () => {
    // A rejected fetch, as a dropped socket rejects it — the value is input, never a verdict.
    const thrower: RegistryFetch = () => Promise.reject(hangUp);
    const states = await auditRegistry(
      TARGETS.slice(0, 1),
      registry(() => 200),
    );
    expect((await tarballsServed(states, thrower))[0]?.cause).toContain('socket hang up');
    const bare: PublishState = { ...(states[0] as PublishState), tarball: undefined };
    const missing = await tarballsServed(
      [bare],
      registry(() => 200),
    );
    expect(missing.map((finding) => finding.code)).toEqual(['X_REGISTRY_UNREACHABLE']);
  });

  test('a state the audit already flags is not HEADed twice', async () => {
    const seen: string[] = [];
    const absent: PublishState = {
      name: '@ultimat3/gone',
      version: '1.0.0',
      ordinal: 1,
      total: 1,
      kind: 'absent',
    };
    expect(
      await tarballsServed(
        [absent],
        registry(() => 200, seen),
      ),
    ).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe('unit · release.yml · the scaffold waits for every tarball, not only every listing', () => {
  test('the 40-attempt wait runs the audit with --tarballs, before the scaffold installs', async () => {
    const release = await readWorkflow('release.yml');
    const steps = jobOf(release, 'npm-scaffold').steps ?? [];
    const wait = steps.findIndex((step) => text(step.run).includes('scripts/registry-audit.ts'));
    const scaffold = steps.findIndex((step) => text(step.run).includes('bunx "create-ultimate@'));
    expect(wait).toBeGreaterThanOrEqual(0);
    expect(scaffold).toBeGreaterThan(wait);
    const loop = text(steps[wait]?.run);
    expect(loop).toContain('for attempt in $(seq 1 40)');
    expect(loop).toContain('bun run scripts/registry-audit.ts --tarballs --json');
  });
});
