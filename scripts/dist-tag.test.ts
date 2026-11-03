// Which npm dist-tag a release publishes under (wiki/Stability.md's support row): the current
// major's release is `latest`, a patch to the previous major is `maint-<major>`, a prerelease is
// `next`. The registry is a fixture, so a maintenance publish is proven to leave `latest` alone.

import { describe, expect, test } from 'bun:test';
import { distTagFor, distTagResult, servingTag } from './dist-tag';
import { packumentUrl, type RegistryFetch } from './registry-audit';

const registry =
  (latest: string | undefined, status = 200): RegistryFetch =>
  (url) =>
    Promise.resolve(
      url === packumentUrl('@ultimat3/core')
        ? new Response(JSON.stringify({ 'dist-tags': latest === undefined ? {} : { latest } }), {
            status,
          })
        : new Response('{}', { status: 404 }),
    );

describe('unit · dist-tag · the tag a version publishes under', () => {
  test('the current major, or a newer one, is latest', () => {
    expect(servingTag('30.1.0', '30.0.0')).toBe('latest');
    expect(servingTag('31.0.0', '30.4.2')).toBe('latest');
    expect(servingTag('30.0.0', undefined)).toBe('latest');
  });

  test('a release of an older major is maint-<major>, never latest', () => {
    expect(servingTag('29.4.1', '30.2.0')).toBe('maint-29');
  });

  test('a prerelease is next', () => {
    expect(servingTag('31.0.0-next.3', '30.2.0')).toBe('next');
  });

  test('an older release of the current major is refused, not published over latest', () => {
    const read = distTagFor('30.1.1', '30.2.0');
    expect('finding' in read && read.finding.code).toBe('X_RELEASE_VERSION_INVALID');
  });
});

describe('unit · dist-tag · read against the registry', () => {
  test('a dry-run maintenance publish leaves dist-tags.latest unchanged', async () => {
    const result = await distTagResult('29.4.1', registry('30.2.0'));
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ version: '29.4.1', latest: '30.2.0', tag: 'maint-29' });
  });

  test('the first publish of a package npm does not hold yet is latest', async () => {
    const result = await distTagResult('30.0.0', registry(undefined, 404));
    expect(result.data).toEqual({ version: '30.0.0', tag: 'latest' });
  });

  test('a registry that does not answer refuses: a wrong guess moves latest for good', async () => {
    const result = await distTagResult('29.4.1', registry('30.2.0', 503));
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.code)).toEqual(['X_REGISTRY_UNREACHABLE']);
  });

  test('an older release of the current major is refused by name, against the registry', async () => {
    const result = await distTagResult('30.1.1', registry('30.2.0'));
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.code)).toEqual(['X_RELEASE_VERSION_INVALID']);
  });
});
