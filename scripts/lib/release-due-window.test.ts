// The release-due decision once the major window is open (wiki/Stability.md): a pending major
// before its window names the date it opens on, and after that date reads as it always did.
// Split from `release-due-rule.test.ts`, which is near the size ceiling.

import { describe, expect, test } from 'bun:test';
import type { DueInput } from './release-due-rule';
import { releaseDue } from './release-due-rule';

const NOW = Date.UTC(2026, 10, 20, 12);

const input = (overrides: Partial<DueInput> = {}): DueInput => ({
  tagged: '30.0.0',
  stamped: '30.0.0',
  commits: [
    {
      sha: 'a'.repeat(40),
      subject: 'feat(core)!: a thing goes (#9)',
      author: 'Outside Contributor',
      committedAt: Math.floor(NOW / 1000) - 48 * 3600,
      files: ['packages/core/src/a.ts'],
    },
  ],
  unreleased: '### Changed\n\n- **BREAKING — a thing goes.** detail',
  nowMs: NOW,
  settleHours: 24,
  ships: (path) => /^packages\/([^/]+)\/src\//.exec(path)?.[1],
  openIssueTitles: [],
  ...overrides,
});

describe('unit · release-due-rule · the major window', () => {
  test('inside the window the major names the next window; its dry run is the refusal to read', () => {
    const decision = releaseDue(input({ majorWindowOpensOn: '2027-02-08' }));
    expect(decision.reason).toBe('major_needs_a_maintainer');
    expect(decision.windowOpensOn).toBe('2027-02-08');
    expect(decision.detail).toContain('next window on 2027-02-08');
    expect(decision.detail).toContain('the `next` branch');
    expect(decision.command).toBe('bun run scripts/release.ts --version 31.0.0 --dry-run --json');
  });

  test('on or after the date, the window says nothing and the maintainer path is unchanged', () => {
    const decision = releaseDue(input({ majorWindowOpensOn: '2026-11-20' }));
    expect(decision.windowOpensOn).toBeUndefined();
    expect(decision.detail).not.toContain('next window');
    expect(decision.command).toBe('bun run scripts/release.ts --version 31.0.0 --dry-run --json');
  });

  test('no window known (before v30) reads exactly as before', () => {
    const decision = releaseDue(input());
    expect(decision.windowOpensOn).toBeUndefined();
    expect(decision.detail).not.toContain('next window');
  });
});
