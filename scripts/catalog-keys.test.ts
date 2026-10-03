// The enforcement half of `scripts/catalog-keys.ts`: a key the framework carries to `t()` in a
// constant or a property, and no shipped catalog answers, fails the gate's `unit` step here. The
// fixtures prove each carrier shape; the last block holds the real tree, non-vacuously.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { Catalog } from '@ultimat3/i18n';
import type { SourceText } from './catalog-keys';
import {
  assignedNames,
  carriedKeySites,
  carriedKeys,
  catalogKeyFinding,
  catalogKeyGaps,
  checkCarriedKeys,
  deriveCarriers,
} from './catalog-keys';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const file = (path: string, lines: readonly string[]): SourceText => ({
  path,
  text: lines.join('\n'),
});

/** Every carried key the fixture set yields, as `path:line key`. */
const scan = (files: readonly SourceText[]): readonly string[] => {
  const carriers = assignedNames(files, deriveCarriers(files));
  return files.flatMap((one) =>
    carriedKeys(one, carriers).map((site) => `${site.path}:${String(site.line)} ${site.key}`),
  );
};

const RENDER = file('packages/a/src/screen.tsx', [
  'export const Row = (row) => <span>{t(row.reason)}</span>;',
  'export const Title = (p) => <h1>{t(p.titleKey)}</h1>;',
  'export const Foot = () => t(UNSUBSCRIBE_KEY);',
  'export const Close = () => ui.t(UI_KEYS.close);',
]);

describe('carriers are read off the dynamic t() calls', () => {
  test('a member chain names its last segment; a SCREAMING head names a key table', () => {
    const carriers = deriveCarriers([RENDER]);
    expect([...carriers.names].sort()).toEqual(['UNSUBSCRIBE_KEY', 'reason', 'titleKey']);
    expect([...carriers.tables]).toEqual(['UI_KEYS']);
  });

  test('`key` is never a carrier, and `.at(` is not `t(`', () => {
    const carriers = deriveCarriers([file('x.ts', ['t(block.key); list.at(index);', 't(key)'])]);
    expect([...carriers.names]).toEqual([]);
  });
});

describe('a carried key is found in each shape', () => {
  test('a property, a constant assigned to a carrier, a constant passed to t(), a table member', () => {
    const data = file('packages/a/src/data.ts', [
      "export const ROW_CHANGED_REASON = 'admin.error.row-changed';",
      "export const UNSUBSCRIBE_KEY = 'mail.footer.unsubscribe';",
      "const UI_KEYS = { close: 'ui.close', cancel: 'ui.cancel' };",
      'const out = {',
      "  reason: 'admin.search.skipped.no-repo',",
      "  titleKey: 'admin.jobs.title',",
      '  other: ROW_CHANGED_REASON,',
      '};',
      'push({ entity, reason: ROW_CHANGED_REASON });',
    ]);
    expect(scan([RENDER, data])).toEqual([
      'packages/a/src/data.ts:5 admin.search.skipped.no-repo',
      'packages/a/src/data.ts:6 admin.jobs.title',
      'packages/a/src/data.ts:1 admin.error.row-changed',
      'packages/a/src/data.ts:2 mail.footer.unsubscribe',
      'packages/a/src/data.ts:3 ui.close',
      'packages/a/src/data.ts:3 ui.cancel',
    ]);
  });

  test('a ternary branch, a non-carrier property and prose are not carried keys', () => {
    const data = file('packages/a/src/data.ts', [
      "const reason = typeof inner.reason === 'string' ? inner.reason : 'admin.policy.evaluated';",
      "const cfg = { key: 'realtime.transport', path: 'admin.users.list' };",
      "const out = { reason: 'the row changed under you' };",
    ]);
    expect(scan([RENDER, data])).toEqual([]);
  });
});

describe('the check', () => {
  const catalog: Catalog = { 'admin.jobs.title': 'Jobs' };
  const site = {
    path: 'packages/a/src/data.ts',
    line: 6,
    key: 'admin.jobs.titel',
    via: 'titleKey:',
  };

  test('a carried key no catalog answers is X_CATALOG_MISSING_KEYS, at the site', () => {
    const [gap] = checkCarriedKeys([site], [catalog]);
    const finding = catalogKeyFinding(gap ?? expect.unreachable());
    expect(finding.code).toBe('X_CATALOG_MISSING_KEYS');
    expect(finding.at).toBe('packages/a/src/data.ts:6');
    expect(finding.cause).toContain('⟦admin.jobs.titel⟧');
  });

  test('a key any shipped catalog answers is clean — the mail catalog counts', () => {
    const mail: Catalog = { 'mail.footer.unsubscribe': 'Unsubscribe' };
    const ok = { ...site, key: 'mail.footer.unsubscribe' };
    expect(checkCarriedKeys([ok, { ...site, key: 'admin.jobs.title' }], [catalog, mail])).toEqual(
      [],
    );
  });

  test('a scan that carried nothing is X_CATALOG_CARRIER_UNSCANNED, never clean', () => {
    const [gap] = checkCarriedKeys([], [catalog]);
    expect(catalogKeyFinding(gap ?? expect.unreachable()).code).toBe('X_CATALOG_CARRIER_UNSCANNED');
  });
});

describe('the real tree', () => {
  test('reads the carried keys plan 101 found missing, and every one resolves', async () => {
    const keys = (await carriedKeySites(repoRoot())).map((site) => site.key);
    // Non-vacuity, by name: the two keys the admin shipped without (status.yml, PR 11b) and one
    // from each other carrier shape — a constant, a mail subject, a `UI_KEYS` member.
    for (const key of [
      'admin.error.row-changed',
      'admin.search.skipped.failed',
      'mail.footer.unsubscribe',
      'mail.welcome.subject',
      'ui.close',
    ]) {
      expect(keys).toContain(key);
    }
    expect(await catalogKeyGaps(repoRoot())).toEqual([]);
  });
});
