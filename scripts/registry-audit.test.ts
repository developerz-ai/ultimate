// The audit's four answers and its one non-answer, driven by fixtures. The network is injected on
// purpose: a test that resolves npm reports the registry's mood, not this repo's state — and the
// measured propagation lag (minutes, PUBLISHING.md) makes "absent" the flakiest possible fixture.

import { describe, expect, test } from 'bun:test';
import { ScriptError } from './lib/script-error';
import type { PublishState, RegistryFetch } from './registry-audit';
import {
  auditRegistry,
  findingFor,
  ordinalLabel,
  packumentUrl,
  registryFindings,
} from './registry-audit';

/** An empty audit must fail the test loudly, never hand `findingFor` a fabricated state. */
const only = (states: readonly PublishState[]): PublishState => {
  const first = states[0];
  if (first === undefined || states.length !== 1) {
    throw new ScriptError({
      code: 'X_CLI_UNEXPECTED',
      cause: `the audit answered ${states.length} states where the fixture supplies one`,
      fix: 'pass exactly one target to auditRegistry() in scripts/registry-audit.test.ts',
    });
  }
  return first;
};

const attested = {
  dist: { tarball: 'https://registry.npmjs.org/x.tgz', attestations: { url: 'https://x/att' } },
  _npmUser: { name: 'GitHub Actions' },
};

const handPublished = {
  dist: { tarball: 'https://registry.npmjs.org/x.tgz' },
  _npmUser: { name: 'sebyx07' },
};

const packument = (name: string, versions: Record<string, unknown>, latest: string): string =>
  JSON.stringify({ name, 'dist-tags': { latest }, versions });

/** Answers per URL; anything unlisted is a 404, which is what the registry does. */
const fetcherFor = (bodies: Record<string, { body: string; status?: number }>): RegistryFetch => {
  return (url) => {
    const answer = bodies[url];
    if (answer === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
    return Promise.resolve(new Response(answer.body, { status: answer.status ?? 200 }));
  };
};

const target = (name: string, version = '3.0.0'): { name: string; version: string } => ({
  name,
  version,
});

describe('a network failure is never reported as absent', () => {
  test('a fetch that throws is unreachable, and says so', async () => {
    const thrown: RegistryFetch = () => Promise.reject(new Error('ETIMEDOUT'));
    const states = await auditRegistry([target('@ultimat3/core')], thrown);
    expect(states[0]?.kind).toBe('unreachable');
    const finding = findingFor(only(states));
    expect(finding?.code).toBe('X_REGISTRY_UNREACHABLE');
    expect(finding?.cause).toContain('ETIMEDOUT');
    // The whole point of the separate outcome: nobody may read a timeout as a bootstrap.
    expect(finding?.cause).toContain('not evidence');
    expect(finding?.fix).not.toContain('npm publish');
  });

  test('a rate limit is unreachable, not absent', async () => {
    const limited = fetcherFor({
      [packumentUrl('@ultimat3/core')]: { body: '{"error":"rate limit"}', status: 429 },
    });
    const states = await auditRegistry([target('@ultimat3/core')], limited);
    expect(states[0]?.kind).toBe('unreachable');
    expect(findingFor(only(states))?.cause).toContain('429');
  });

  test('a 200 that is not a packument is unreachable, not present', async () => {
    const html = fetcherFor({ [packumentUrl('@ultimat3/core')]: { body: '<html>maintenance' } });
    expect((await auditRegistry([target('@ultimat3/core')], html))[0]?.kind).toBe('unreachable');
    // Valid JSON, and still not a packument — the shape guard, not the parse, is what catches it.
    const nul = fetcherFor({ [packumentUrl('@ultimat3/core')]: { body: 'null' } });
    expect((await auditRegistry([target('@ultimat3/core')], nul))[0]?.kind).toBe('unreachable');
  });
});

describe('absent from the registry names the ordinal and the cost', () => {
  test('the third of four says a run publishes two before it dies', async () => {
    const names = ['a', 'b', 'c', 'd'].map((n) => target(`@ultimat3/${n}`));
    const present = Object.fromEntries(
      names
        .filter((entry) => entry.name !== '@ultimat3/c')
        .map((entry) => [
          packumentUrl(entry.name),
          { body: packument(entry.name, { '3.0.0': attested }, '3.0.0') },
        ]),
    );
    const findings = registryFindings(await auditRegistry(names, fetcherFor(present)));
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding?.code).toBe('X_REGISTRY_BOOTSTRAP_OWED');
    expect(finding?.cause).toContain('3rd of 4');
    expect(finding?.cause).toContain('publishes 2');
    // The bootstrap command PUBLISHING.md step 1 names, verbatim — never a re-run of the workflow.
    expect(finding?.fix).toContain('npm publish -w @ultimat3/c --access public --provenance=false');
  });

  test('ordinals read as English, 11th through 13th included', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 27, 30].map(ordinalLabel)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '27th',
      '30th',
    ]);
  });
});

describe('present but behind the stamped version', () => {
  test('the registry holding only the previous version is behind, not ok', async () => {
    const behind = fetcherFor({
      [packumentUrl('@ultimat3/core')]: {
        body: packument('@ultimat3/core', { '2.0.0': attested }, '2.0.0'),
      },
    });
    const states = await auditRegistry([target('@ultimat3/core', '3.0.0')], behind);
    expect(states[0]?.kind).toBe('behind');
    const finding = findingFor(only(states));
    expect(finding?.code).toBe('X_REGISTRY_VERSION_BEHIND');
    expect(finding?.cause).toContain('2.0.0');
    expect(finding?.cause).toContain('3.0.0');
    expect(finding?.fix).toContain('gh workflow run release.yml --ref v3.0.0 -f version=3.0.0');
  });
});

describe('present at the stamped version, hand-published', () => {
  test('no dist.attestations is a finding that names who published it', async () => {
    const unattested = fetcherFor({
      [packumentUrl('@ultimat3/core')]: {
        body: packument('@ultimat3/core', { '2.0.0': handPublished }, '2.0.0'),
      },
    });
    const states = await auditRegistry([target('@ultimat3/core', '2.0.0')], unattested);
    expect(states[0]?.kind).toBe('unattested');
    const finding = findingFor(only(states));
    expect(finding?.code).toBe('X_REGISTRY_UNATTESTED');
    expect(finding?.cause).toContain('sebyx07');
    expect(finding?.fix).toContain('bun run scripts/trust-publishers.ts');
  });

  test('an attested version is ok and produces no finding', async () => {
    const good = fetcherFor({
      [packumentUrl('@ultimat3/core')]: {
        body: packument('@ultimat3/core', { '3.0.0': attested }, '3.0.0'),
      },
    });
    const states = await auditRegistry([target('@ultimat3/core')], good);
    expect(states[0]?.kind).toBe('ok');
    expect(states[0]?.publishedBy).toBe('GitHub Actions');
    expect(findingFor(only(states))).toBeUndefined();
    expect(registryFindings(states)).toHaveLength(0);
  });
});

describe('the request itself', () => {
  test('a scoped name is escaped for the packument path', () => {
    expect(packumentUrl('@ultimat3/core')).toBe('https://registry.npmjs.org/@ultimat3%2fcore');
  });

  test('a request that never answers aborts on the timeout, as unreachable', async () => {
    const signals: AbortSignal[] = [];
    // Answers only when aborted, which is what a hung connection does — so this passes only while
    // the request carries a REAL deadline. A bare controller here hangs the whole audit.
    const hangs: RegistryFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        signals.push(init.signal);
        init.signal.addEventListener('abort', () => reject(new Error('aborted by the deadline')));
      });
    const states = await auditRegistry([target('@ultimat3/core')], hangs, 5);
    expect(states[0]?.kind).toBe('unreachable');
    expect(findingFor(only(states))?.cause).toContain('aborted by the deadline');
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});
