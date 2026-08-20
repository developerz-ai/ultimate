// The rule's own negative cases, as fixtures rather than as edits to pages three other people are
// rewriting — the reason `checkGeneratorCounts` is pure over a page list.

import { describe, expect, test } from 'bun:test';
import {
  checkGeneratorCounts,
  type GeneratorFacts,
  generatorFacts,
  ownerOf,
  readCountClaims,
  readMentions,
  readTranscriptClaims,
} from './generator-counts';

const FACTS: readonly GeneratorFacts[] = [
  {
    id: 'x new',
    variants: [
      { flags: [], files: 125 },
      { flags: ['--no-example'], files: 99 },
    ],
  },
  {
    id: 'x g resource',
    variants: [
      { flags: [], files: 27 },
      { flags: ['--admin'], files: 29 },
    ],
  },
];

const gapsFor = (text: string): readonly string[] =>
  checkGeneratorCounts({ pages: [{ path: 'p.md', text }], facts: FACTS })
    .filter((gap) => gap.kind === 'stale')
    .map((gap) => `${gap.generator}:${String(gap.claimed)}`);

describe('the counts come from the generators, never from this file', () => {
  test('every modelled variant is a real plan length, and the plans differ', () => {
    const facts = generatorFacts();
    expect(facts.map((entry) => entry.id)).toEqual(['x new', 'x g resource']);
    for (const entry of facts) {
      for (const variant of entry.variants) expect(variant.files).toBeGreaterThan(0);
      const counts = entry.variants.map((variant) => variant.files);
      // A flag that changed nothing would make the two variants indistinguishable, and every
      // assertion about "the flagged spelling" below would then hold for the wrong reason.
      expect(new Set(counts).size).toBe(counts.length);
    }
  });
});

describe('what counts as a claim', () => {
  test('`N files`, `N with` and `N without` are claims; a bare integer is not', () => {
    expect(readCountClaims('125 files, 99 with `--no-example`').map((c) => c.value)).toEqual([
      125, 99,
    ]);
    // The history on wiki/CLI-Reference.md. A rule that read every integer fails on this line.
    expect(readCountClaims('up from 114/90 because it grew').map((c) => c.value)).toEqual([]);
  });

  test('flags attach to the claim they follow, never to the next one', () => {
    const claims = readCountClaims('**125 files** with the slice, **99** with `--no-example`');
    expect(claims[0]?.flags).toEqual([]);
    expect(claims[1]?.flags).toEqual(['--no-example']);
    expect(claims[1]?.associated).toBe(true);
  });

  test('`without` never associates its flags — the corpus writes the inverse sentence', () => {
    const [first, second] = readCountClaims('29 files — 27 without `--admin`');
    expect(first?.value).toBe(29);
    expect(second?.associated).toBe(false);
  });

  test('a count qualified by a path or a chart is about that artifact, not the generator', () => {
    expect(readCountClaims('`x new` writes `docker/helm`, 8 files')[0]?.qualified).toBe(true);
    expect(readCountClaims('helm/ — the chart, 8 files')[0]?.qualified).toBe(true);
    expect(readCountClaims('the whole slice — 27 files')[0]?.qualified).toBe(false);
  });
});

describe('which generator a claim belongs to', () => {
  test('the invocation nearest before it wins, so one line can state two', () => {
    const line = '`x g job` is 5 files into a bare slice, `x g action` 8 files.';
    const mentions = readMentions(line);
    const claims = readCountClaims(line);
    expect(ownerOf(mentions, claims[0] as never)).toBe('x g job');
    expect(ownerOf(mentions, claims[1] as never)).toBe('x g action');
  });

  test('a claim before the only invocation on the line still belongs to it', () => {
    const line = '**125 files** with the slice — measured because `x new` now writes more';
    expect(ownerOf(readMentions(line), readCountClaims(line)[0] as never)).toBe('x new');
  });

  test('a claim before two different invocations belongs to neither', () => {
    const line = '27 files, then `x new` and `x g resource` both changed';
    expect(ownerOf(readMentions(line), readCountClaims(line)[0] as never)).toBeUndefined();
  });
});

describe('the two rules', () => {
  test('membership: a count no variant emits is stale, whichever direction the prose runs', () => {
    // Two findings, and the second is the association rule below: 27 is a real count of this
    // generator, but not of the spelling the sentence attaches it to.
    expect(gapsFor('`x g resource` — 25 files, 27 with `--admin`')).toEqual([
      'x g resource:25',
      'x g resource:27',
    ]);
    // The inverted spelling on docs/architecture/15-adding-a-feature.md must stay green.
    expect(gapsFor('`x g resource --live --admin` | 29 files — 27 without either flag')).toEqual(
      [],
    );
  });

  test('association: a valid number under the wrong flag is stale, which membership cannot see', () => {
    expect(gapsFor('`x g resource` — 27 files, 27 with `--admin`')).toEqual(['x g resource:27']);
  });

  test('a swap with no `with` is NOT caught — the limitation, pinned so it cannot be assumed away', () => {
    expect(gapsFor('`x g resource` — 29 files, 27 without either flag')).toEqual([]);
  });

  test('a path-qualified count is not read as the generator total', () => {
    expect(gapsFor('`x new` writes `docker/helm`, 8 files')).toEqual([]);
  });

  test('the generator’s own transcript line parses to a count and a kind', () => {
    // `cli.generate.wrote` in packages/cli/src/messages.ts, and `--dry-run`'s `would write`.
    expect(readTranscriptClaims('✓ wrote 25 file(s) for resource todo')).toEqual([
      { value: 25, id: 'x g resource' },
    ]);
    expect(readTranscriptClaims('would write 4 file(s) for job nudge')).toEqual([
      { value: 4, id: 'x g job' },
    ]);
    expect(readTranscriptClaims('wrote the file')).toEqual([]);
  });

  test('the generator’s own transcript line is checked exactly', () => {
    expect(gapsFor('✓ wrote 25 file(s) for resource todo')).toEqual(['x g resource:25']);
    expect(gapsFor('✓ wrote 27 file(s) for resource todo')).toEqual([]);
    expect(gapsFor('would write 99 file(s) for new demo')).toEqual([]);
  });
});

describe('the false green', () => {
  test('a corpus stating no count at all is a finding, not agreement', () => {
    const gaps = checkGeneratorCounts({
      pages: [{ path: 'p.md', text: 'no numbers' }],
      facts: FACTS,
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(['vacuous']);
  });
});
