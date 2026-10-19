// The worktree rule — both files must agree. The run is the worktree, the file set is the lock,
// and `sub-worktree`, `isolation: worktree` and per-agent directories fragment the checkout, so
// each site that names the rule forbids all three and anchors to
// `packages/cli/src/dev-watch.ts:33-34` (the worktree incident recorded at `CHANGELOG.md:7882`).
// The old, unqualified rule is gone — a test fails if `Do not use git worktrees — work directly
// in this checkout`, `never use git worktrees`, or `no git worktrees.` ever returns, bare or
// "qualified" by a `sub-` / `isolation:` mention in the same paragraph.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
const feature = readFileSync(join(ROOT, '.claude/commands/feature.md'), 'utf8');

// The verbatim substring `## Note` carried in the old rule — character-for-character, em-dash
// included.
const OLD_NOTE_LITERAL = 'Do not use git worktrees — work directly in this checkout';

const RE_NEVER_BARE = /never use git worktrees/i;
const RE_NO_BARE = /\bno git worktrees\./i;

// The agreed framing — "the run is the worktree", matched flexibly across CLAUDE.md's "that
// checkout IS the worktree" and feature.md's "the run is already a worktree". The leading
// article and the verb's case are both optional; what must hold is `<run-or-checkout> is …
// <the|a> worktree` (with "already" allowed between `is` and the article).
const RE_RUN_IS_WORKTREE =
  /\b(?:the |this |that |a )?(?:run|checkout|tree|repo)\s+is\s+(?:already\s+)?(?:the|a)\s+worktree\b/i;

const ANCHOR = 'packages/cli/src/dev-watch.ts:33-34';
const SUB = 'sub-worktree';
const ISOLATION = 'isolation: worktree';
const PER_AGENT = 'per-agent';

// Coarse qualification rule, exactly the one the brief defines: a `sub-worktree` or
// `isolation: worktree` anywhere in the section lifts `never/no git worktrees` from "old" to
// "new". `\bsub-` matches the literal hyphen-prefixed form (excluding `subagent`); the second
// branch matches the backticked and bare forms of `isolation: worktree` identically.
const QUALIFIER = /\bsub-|\bisolation:\s*worktree/;

// Returns the first forbidden, unqualified substring in `text`, or '' when none. Empty-string is
// the "this site is clean" verdict the rest of the suite reads.
const unqualifiedForbidden = (text: string): string => {
  if (text.includes(OLD_NOTE_LITERAL)) return OLD_NOTE_LITERAL;
  const never = RE_NEVER_BARE.exec(text);
  if (never !== null && !QUALIFIER.test(text)) return never[0];
  const no = RE_NO_BARE.exec(text);
  if (no !== null && !QUALIFIER.test(text)) return no[0];
  return '';
};

// Pulls the body of a `## Heading` section — text from the heading line to the next `## `
// heading (or EOF). The heading line itself may carry a subtitle (`## Hard rules (from …)`), so
// the regex only anchors at the start. Used to scope checks to the section the brief names,
// not the whole file.
const section = (text: string, heading: string): string => {
  const re = new RegExp(`^##\\s+${heading}\\b`, 'm');
  const start = re.exec(text);
  if (start === null || start.index === undefined) return '';
  const rest = text.slice(start.index + start[0].length);
  const end = rest.search(/^##\s/m);
  return end === -1 ? rest : rest.slice(0, end);
};

const expectCarriesFraming = (where: string, text: string): void => {
  const missing: string[] = [];
  if (!RE_RUN_IS_WORKTREE.test(text)) missing.push('"the run is … a worktree"');
  if (!text.includes(SUB)) missing.push(`\`${SUB}\``);
  if (!text.includes(ISOLATION)) missing.push(`\`${ISOLATION}\``);
  if (!text.includes(PER_AGENT)) missing.push(`\`${PER_AGENT}\` directory`);
  if (!text.includes(ANCHOR)) missing.push(`\`${ANCHOR}\` anchor`);
  if (missing.length > 0) {
    throw new Error(`${where} misses the worktree framing: ${missing.join(', ')}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────────────────
// The verifier, in isolation. Build every case by hand — the tree is input data, the failure
// case is the assertion that proves the check is not a no-op.
// ─────────────────────────────────────────────────────────────────────────────────────────

describe('unqualifiedForbidden — the old-rule detector', () => {
  test('the verbatim `## Note` literal is reported, exactly', () => {
    const found = unqualifiedForbidden(`before\n${OLD_NOTE_LITERAL}\nafter`);
    expect(found).toBe(OLD_NOTE_LITERAL);
  });

  test('`never use git worktrees` is bare and reported', () => {
    const bare = 'Never use git worktrees — work directly in this checkout.';
    expect(unqualifiedForbidden(bare)).toBe('Never use git worktrees');
  });

  test('`no git worktrees.` (case-insensitive) is bare and reported', () => {
    expect(unqualifiedForbidden('a `no git worktrees.` rule hard-locks the tree')).toBe(
      'no git worktrees.',
    );
    expect(unqualifiedForbidden('NO GIT WORKTREES. period.')).toBe('NO GIT WORKTREES.');
  });

  test('a `sub-worktree` reference in the same section lifts the verdict', () => {
    const text =
      'Never use git worktrees in the old sense — but `sub-worktree` is the new forbidden form.';
    expect(unqualifiedForbidden(text)).toBe('');
  });

  test('an `isolation: worktree` reference in the same section lifts the verdict', () => {
    const text =
      '`No git worktrees.` was the old rule; the new rule forbids `isolation: worktree`.';
    expect(unqualifiedForbidden(text)).toBe('');
  });

  test('the clean framing reads as empty', () => {
    const clean =
      'this run is the worktree; forbid sub-worktree, isolation: worktree, and per-agent ' +
      'directories (see packages/cli/src/dev-watch.ts:33-34)';
    expect(unqualifiedForbidden(clean)).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// The two files the brief names.
// ─────────────────────────────────────────────────────────────────────────────────────────

const claudeNote = section(claude, 'Note');

describe('CLAUDE.md — `## Note`', () => {
  test('the section exists', () => {
    expect(claudeNote.length).toBeGreaterThan(0);
  });

  test('carries the agreed framing (run-is-worktree, sub-worktree, isolation: worktree, per-agent, dev-watch anchor)', () => {
    expectCarriesFraming('CLAUDE.md ## Note', claudeNote);
  });

  test('does not regress to the old unqualified rule', () => {
    expect(unqualifiedForbidden(claudeNote)).toBe('');
  });

  test('no unqualified forbidden wording appears anywhere in the file', () => {
    expect(unqualifiedForbidden(claude)).toBe('');
  });
});

// feature.md — three named sites: frontmatter description, the hive body, the hard-rules
// section. Each is matched by structure (heading or YAML key), not by literal line number, so
// the test still pins the rule if the surrounding text grows or shifts.
const featureFrontmatterDescription = ((): string => {
  const block = feature.match(/^---\n([\s\S]*?)\n---\n/);
  if (block === null) return '';
  const line = block[1].match(/^description:\s*([\s\S]*?)(?=^[a-z][a-z-]+:\s|\s*$)/m);
  return line?.[1]?.trim() ?? '';
})();

const featureHiveBody = ((): string => {
  const re = /^##\s+Work as a hive mind[^\n]*$/m;
  const start = re.exec(feature);
  if (start === null || start.index === undefined) return '';
  const rest = feature.slice(start.index + start[0].length);
  const end = rest.search(/^##\s/m);
  return end === -1 ? rest : rest.slice(0, end);
})();

const featureHardRules = section(feature, 'Hard rules');

describe('.claude/commands/feature.md — the three named sites', () => {
  test('all three sites exist in the file', () => {
    expect(featureFrontmatterDescription.length).toBeGreaterThan(0);
    expect(featureHiveBody.length).toBeGreaterThan(0);
    expect(featureHardRules.length).toBeGreaterThan(0);
  });

  test('the frontmatter description carries the framing', () => {
    expectCarriesFraming(
      '.claude/commands/feature.md frontmatter description',
      featureFrontmatterDescription,
    );
  });

  test('the `## Work as a hive mind` body carries the framing', () => {
    expectCarriesFraming(
      '.claude/commands/feature.md `## Work as a hive mind, in one checkout` body',
      featureHiveBody,
    );
  });

  test('the `## Hard rules` section carries the framing', () => {
    expectCarriesFraming('.claude/commands/feature.md `## Hard rules`', featureHardRules);
  });

  test('no site regresses to the old unqualified rule', () => {
    expect(unqualifiedForbidden(featureFrontmatterDescription)).toBe('');
    expect(unqualifiedForbidden(featureHiveBody)).toBe('');
    expect(unqualifiedForbidden(featureHardRules)).toBe('');
  });

  test('no unqualified forbidden wording appears anywhere in the file', () => {
    expect(unqualifiedForbidden(feature)).toBe('');
  });
});
