// The lockstep rule: every published package at one version, sibling pins included — a release that
// leaves one behind publishes a manifest naming a version the registry does not have.

import { describe, expect, test } from 'bun:test';
import { checkLockstep, frameworkDepsOf, pinSkewFinding } from './workspace-checks';
import { pkg } from './workspace-checks-fixture';

/** A sibling pin the release script bumped everywhere except here — the skew that actually shipped. */
const STALE_PEER = { '@ultimat3/action': '0.0.1' };
const STALE_OPTIONAL = { '@ultimat3/db': '0.0.1' };

describe('checkLockstep', () => {
  test('every published package at one version, pins included, is clean', () => {
    expect(
      checkLockstep([
        pkg({ dir: 'core' }),
        pkg({ dir: 'jobs', frameworkDeps: [['@ultimat3/core', '1.0.0']] }),
      ]),
    ).toEqual([]);
  });

  test('a package left behind at the old version is a finding', () => {
    const findings = checkLockstep([pkg({ dir: 'core' }), pkg({ dir: 'ui', version: '0.0.1' })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('X_RELEASE_VERSION_SKEW');
    expect(findings[0]?.cause).toBe('packages/ui is at 0.0.1, not the lockstep version 1.0.0');
    expect(findings[0]?.fix).toBe('bun run scripts/release.ts --version 1.0.0');
  });

  // The release this check exists for: every own version moved to 1.0.0 and every sibling pin
  // stayed at 0.0.1, so @ultimat3/jobs@1.0.0 published naming a @ultimat3/core@0.0.1 that is not
  // on the registry. Nothing in the repo failed; every install of the release did.
  test('a stale sibling pin is a finding even when both versions are right', () => {
    const findings = checkLockstep([
      pkg({ dir: 'core' }),
      pkg({ dir: 'jobs', frameworkDeps: [['@ultimat3/core', '0.0.1']] }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toBe(
      'packages/jobs pins @ultimat3/core at 0.0.1, not the lockstep version 1.0.0',
    );
  });

  test('core is the anchor, so one stray package does not indict every other', () => {
    const findings = checkLockstep([
      pkg({ dir: 'core' }),
      pkg({ dir: 'http' }),
      pkg({ dir: 'ui', version: '9.9.9' }),
    ]);
    expect(findings.map((finding) => finding.at)).toEqual(['packages/ui/package.json']);
  });

  // A generated app has `packages/*` too: private, on their own version line, depending on the
  // framework by caret range. Reporting those would fail `x verify` on unmodified scaffold output.
  test('private packages are exempt on both counts', () => {
    expect(
      checkLockstep([
        pkg({ dir: 'core' }),
        pkg({
          dir: 'db',
          private: true,
          version: '0.0.1',
          frameworkDeps: [['@ultimat3/entity', '^1.0.0']],
        }),
      ]),
    ).toEqual([]);
  });

  test('no published package at all is a no-op, not a crash', () => {
    expect(checkLockstep([pkg({ dir: 'db', private: true })])).toEqual([]);
    expect(checkLockstep([])).toEqual([]);
  });

  // Without an external anchor the rule compares packages only to EACH OTHER, so a repo where all
  // 29 sit at 1.2.0 is green even though the tag being published says v1.10.1 — and `npm publish`
  // then dies `EPUBLISHCONFLICT` on all 29. The gate was green while the tag lied.
  test('a release version anchors the check outside the repo', () => {
    const manifests = [
      pkg({ dir: 'core' }),
      pkg({ dir: 'jobs', frameworkDeps: [['@ultimat3/core', '1.0.0']] }),
    ];
    expect(checkLockstep(manifests)).toEqual([]);
    const findings = checkLockstep(manifests, '1.10.1');
    expect(findings.map((finding) => finding.code)).toEqual([
      'X_RELEASE_VERSION_SKEW',
      'X_RELEASE_VERSION_SKEW',
      'X_RELEASE_VERSION_SKEW',
    ]);
    expect(findings[0]?.cause).toContain('not the lockstep version 1.10.1');
    // The version being released is the anchor whether or not any package already carries it.
    expect(checkLockstep(manifests, '1.0.0')).toEqual([]);
  });
});

describe('frameworkDepsOf', () => {
  test('reads @ultimat3 dependencies and ignores everything else', () => {
    expect(
      frameworkDepsOf({
        dependencies: { '@ultimat3/core': '1.0.0', 'solid-js': '^2.0.0' },
        devDependencies: { '@ultimat3/testing': '1.0.0' },
      }),
    ).toEqual([['@ultimat3/core', '1.0.0']]);
  });

  test('peer and optional pins are published too, so they count', () => {
    expect(
      frameworkDepsOf({
        dependencies: { '@ultimat3/core': '1.0.0' },
        peerDependencies: { '@ultimat3/http': '1.0.0' },
        optionalDependencies: { '@ultimat3/schema': '1.0.0' },
      }),
    ).toEqual([
      ['@ultimat3/core', '1.0.0'],
      ['@ultimat3/http', '1.0.0'],
      ['@ultimat3/schema', '1.0.0'],
    ]);
  });

  test('devDependencies stay excluded — npm never installs them for a consumer', () => {
    expect(frameworkDepsOf({ devDependencies: { '@ultimat3/testing': '0.0.1' } })).toEqual([]);
  });

  test('a manifest with no dependencies block reads as none', () => {
    expect(frameworkDepsOf({})).toEqual([]);
    expect(frameworkDepsOf(null)).toEqual([]);
  });
});

describe('a stale pin in any published field is skew', () => {
  test('a peer pin left behind is reported', () => {
    expect(
      checkLockstep([
        pkg({ dir: 'core' }),
        pkg({ dir: 'render', frameworkDeps: frameworkDepsOf({ peerDependencies: STALE_PEER }) }),
      ]),
    ).toEqual([pinSkewFinding('render', '@ultimat3/action', '0.0.1', '1.0.0')]);
  });

  test('an optional pin left behind is reported', () => {
    expect(
      checkLockstep([
        pkg({ dir: 'core' }),
        pkg({
          dir: 'ai',
          frameworkDeps: frameworkDepsOf({ optionalDependencies: STALE_OPTIONAL }),
        }),
      ]),
    ).toEqual([pinSkewFinding('ai', '@ultimat3/db', '0.0.1', '1.0.0')]);
  });
});
