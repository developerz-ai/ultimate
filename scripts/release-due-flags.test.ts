// The script's own reading surfaces, over the tree it runs on: how a window log is split, what
// `--settle-hours` accepts, and the one JSON envelope a bot branches on. Split from
// `release-due.test.ts`, which owns the release window itself and is at its filesize ceiling, so
// the pure readers are not also the file that builds a repository per test.
//
// These three read no git and no GitHub: the parser and the flag reader are pure, and the
// envelope test runs the SCRIPT for real — which is the point of it, the one surface a consumer
// of `scripts/release-due.ts --json` actually sees.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot, run } from './lib/run';
import { parseWindowLog, settleHoursOf } from './release-due';

// The envelope test runs the script against the real tree, so it contends with every other
// `scripts/` suite under `--parallel` — the repo-scan backstop, not Bun's 5000ms default.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

/** Every refusal `decideAt` can hand back on a real checkout: a tagless shallow clone, a
 * window the log could not read, or HEAD not at the base ref's tip. One list, so a refusal
 * code added to `release-due.ts` cannot slip past the closed set this suite pins. */
const REFUSAL_CODES = [
  'X_RELEASE_TAG_UNREACHABLE',
  'X_RELEASE_WINDOW_UNREADABLE',
  'X_RELEASE_HEAD_NOT_MAIN',
] as const;
type RefusalCode = (typeof REFUSAL_CODES)[number];

describe('unit · release-due · parsing and flags', () => {
  test('the window log splits on control characters, so a subject may hold anything', () => {
    const log = '\x1eabc\x1f100\x1fdependabot[bot]\x1fchore: a | b\n\npackages/core/package.json\n';
    expect(parseWindowLog(log)).toEqual([
      {
        sha: 'abc',
        committedAt: 100,
        author: 'dependabot[bot]',
        subject: 'chore: a | b',
        files: ['packages/core/package.json'],
      },
    ]);
    expect(parseWindowLog('')).toEqual([]);
  });

  test('--settle-hours takes a number of hours at or above zero, and nothing else', () => {
    expect(settleHoursOf(undefined)).toBe(24);
    expect(settleHoursOf('0')).toBe(0);
    expect(settleHoursOf('1.5')).toBe(1.5);
    for (const bad of ['-1', 'soon', '', 'Infinity']) {
      const refused = settleHoursOf(bad);
      expect({ bad, code: typeof refused === 'number' ? refused : refused.code }).toEqual({
        bad,
        code: 'X_CLI_BAD_FLAG',
      });
    }
  });

  test('--json on the real tree is one envelope a bot can branch on', async () => {
    const out = await run(['bun', 'run', 'scripts/release-due.ts', '--json'], {
      cwd: repoRoot(),
    });
    const parsed = JSON.parse(out.output) as {
      ok: boolean;
      script: string;
      data?: { due: boolean; lastTag: string; reason?: string; headSha?: string };
      findings?: readonly { code: RefusalCode }[];
    };
    expect(parsed.script).toBe('release-due');
    // A refusal carries no `data`: every signal a bot branches on is in `findings`. The codes
    // are a closed set — a tagless shallow checkout (TAG_UNREACHABLE), a hung git log
    // (WINDOW_UNREADABLE), or HEAD not at origin/main's tip (HEAD_NOT_MAIN) — so a real-tree
    // run on a side branch keeps the suite green instead of mismatching the prior exact match.
    if (!parsed.ok) {
      expect(parsed.data).toBeUndefined();
      for (const finding of parsed.findings ?? []) {
        expect(REFUSAL_CODES).toContain(finding.code);
      }
      return;
    }
    expect(typeof parsed.data?.due).toBe('boolean');
    expect(parsed.data?.lastTag).toMatch(/^v\d+\.\d+\.\d+$/);
    // The concrete anchor for the consumer: HEAD's SHA at the moment decideAt ran.
    expect(parsed.data?.headSha).toMatch(/^[0-9a-f]{40}$/);
    if (!parsed.data?.due) expect(parsed.data?.reason).toBeDefined();
  });
});
