// The checkup's all-green world for the tests that drive `healthAt`: one injected reader per row,
// each answering its healthy shape, so no case spawns git, gh or npm. One table for every test
// file, so a new row is added here once — a row missing from it fails `satisfies` at typecheck.

import type { HealthReaders } from './health-readers';

/** Every reader's healthy answer; run times are `now`, as the schedule rows read the real clock. */
export const healthyReaders = (now: string = new Date().toISOString()): HealthReaders =>
  ({
    'main-green': async () => ({
      ci: {
        ok: true,
        data: {
          runs: [{ conclusion: 'success', status: 'completed', headSha: 'a'.repeat(40), id: 11 }],
        },
      },
      expectedSha: 'a'.repeat(40),
    }),
    'last-tag-published': async () => ({
      tagCommit: 'a'.repeat(40),
      runs: [{ conclusion: 'success', event: 'workflow_dispatch', headSha: 'a'.repeat(40) }],
    }),
    'stamped-version-tagged': async () => ({
      releaseDue: { ok: true, data: { lastTag: 'v3.0.0', reason: 'settled' } },
    }),
    'tag-runs-ended-well': async () => ({
      runs: [{ conclusion: 'success', status: 'completed' }],
    }),
    'npm-serves-tree': async () => ({
      audit: {
        ok: true,
        data: {
          states: [
            { name: '@ultimat3/core', version: '3.0.0', kind: 'ok', latest: '3.0.0', tagged: true },
          ],
        },
      },
    }),
    'automation-alarms': async () => ({ issues: [] }),
    'dependabot-not-stuck': async () => ({ prs: [] }),
    'demo-shipped': async () => ({
      runs: [{ conclusion: 'success', event: 'workflow_run', status: 'completed', databaseId: 5 }],
    }),
    'release-exists': async () => ({
      tag: 'v3.0.0',
      lookup: {
        kind: 'found',
        release: { tagName: 'v3.0.0', isDraft: false, publishedAt: '2026-01-01T00:00:00Z' },
      },
    }),
    'tutorials-run': async () => ({ runs: [{ conclusion: 'success', status: 'completed' }] }),
    'flake-hunt': async () => ({
      runs: [{ conclusion: 'success', status: 'completed', createdAt: now }],
    }),
    bench: async () => ({ runs: [{ conclusion: 'success', status: 'completed', createdAt: now }] }),
    compat: async () => ({
      runs: [{ conclusion: 'success', status: 'completed', createdAt: now }],
    }),
    // No superseded major in an empty changelog: no window is owed a lane.
    'maint-lane': async () => ({ changelog: [], branches: [], distTags: {} }),
    'registry-trust': async () => ({ otp: true, doc: { ok: true } }),
    'private-names-secret': async () => ({
      kind: 'listed',
      secrets: [{ name: 'ULTIMATE_PRIVATE_NAMES' }],
    }),
    'docs-site-origin': async () => ({
      variables: [{ name: 'DOCS_SITE_ORIGIN', value: 'https://docs.example.org' }],
      pages: {
        cname: 'docs.example.org',
        https_enforced: true,
        https_certificate: { state: 'approved', expires_at: '2999-01-01' },
      },
    }),
    'stale-bot-issues': async () => ({
      issues: [],
      greens: { 'registry-audit.yml': [], 'compat.yml': [] },
    }),
    'stale-branches': async () => ({
      refs: { data: { repository: { refs: { totalCount: 0, nodes: [] } } } },
    }),
  }) satisfies HealthReaders;
