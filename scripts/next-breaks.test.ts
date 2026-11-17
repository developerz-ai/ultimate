// The `next` tracking issue's body: every parked break cited at the `file:line` that parked it,
// resolved from anchors on each run. A moved anchor and a Known-Gaps row parked on `next` that no
// break lists both refuse, so the issue cannot quietly fall behind the plans and the ledger.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { ParkedBreak } from './lib/next-breaks-list';
import { NEXT_TRACKING_TITLE, PARKED_BREAKS } from './lib/next-breaks-list';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { locateBreaks, nextBreaks, renderBody, unlistedGaps } from './next-breaks';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const made: string[] = [];
afterAll(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const ONE: ParkedBreak = {
  ids: 'Z1',
  title: 'a thing goes',
  change: 'the thing is gone',
  sources: [{ path: 'docs/plan.md', anchor: '| Z1 | parked' }],
};

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'next-breaks-'));
  made.push(dir);
  for (const [path, text] of Object.entries(files)) await Bun.write(join(dir, path), text);
  return dir;
}

describe('unit · next-breaks · each source resolves to exactly one line', () => {
  test('an anchor on one line is cited at that line, 1-based', async () => {
    const dir = await tree({ 'docs/plan.md': '# plan\n\n| Z1 | parked for next |\n' });
    const { located, findings } = await locateBreaks(dir, [ONE]);
    expect(findings).toEqual([]);
    expect(located[0]?.citations).toEqual([{ path: 'docs/plan.md', line: 3 }]);
  });

  test('a missing anchor, a doubled anchor and a missing file each refuse', async () => {
    for (const files of [
      { 'docs/plan.md': '# plan, the row moved\n' },
      { 'docs/plan.md': '| Z1 | parked\n| Z1 | parked again\n' },
      {},
    ]) {
      const dir = await tree(files);
      const { findings } = await locateBreaks(dir, [ONE]);
      expect(findings.map((finding) => finding.code)).toEqual(['X_NEXT_BREAK_SOURCE_MOVED']);
      expect(findings[0]?.fix).toStartWith('edit scripts/lib/next-breaks-list.ts:1 — ');
    }
  });
});

describe('unit · next-breaks · a removal is cited at its declaration', () => {
  const REMOVES: ParkedBreak = {
    ...ONE,
    sources: [],
    removes: [
      { path: 'packages/z/src/a.ts', symbol: 'foo' },
      { path: 'packages/z/src/a.ts', symbol: 'bar' },
    ],
  };
  const SOURCE =
    '/** @deprecated removed at the next major. */\nexport function foo() {}\nexport const bar = 1;\n';

  test('a tagged removal is cited plain, an untagged one owes its tag', async () => {
    const dir = await tree({ 'packages/z/src/a.ts': SOURCE });
    const tagged = [{ path: 'packages/z/src/a.ts', line: 1, symbol: 'foo' }];
    const { located, findings } = await locateBreaks(dir, [REMOVES], tagged);
    expect(findings).toEqual([]);
    expect(located[0]?.citations).toEqual([
      { path: 'packages/z/src/a.ts', line: 2 },
      { path: 'packages/z/src/a.ts', line: 3, tagOwed: true },
    ]);
    expect(renderBody(located)).toContain('a.ts#L3) (`@deprecated` owed)');
  });

  test('a removal its file no longer declares refuses', async () => {
    const dir = await tree({ 'packages/z/src/a.ts': 'export function foo() {}\n' });
    const { findings } = await locateBreaks(dir, [REMOVES]);
    expect(findings.map((finding) => finding.code)).toEqual(['X_NEXT_BREAK_SOURCE_MOVED']);
    expect(findings[0]?.cause).toContain('declares no `bar`');
  });
});

describe('unit · next-breaks · the ledger cannot park a break the issue omits', () => {
  test('a Known-Gaps row parked on `next` that no break cites refuses', () => {
    const gaps = [
      '| Gap | Detail |',
      '|---|---|',
      '| Z1 row | refusal is planned for `next` |',
      '| a thing | fixed on main |',
      '| Z2 row | the flip waits on `next` |',
    ].join('\n');
    const cited: ParkedBreak = {
      ...ONE,
      sources: [{ path: 'wiki/Known-Gaps.md', anchor: '| Z1 row |' }],
    };
    const findings = unlistedGaps(gaps, [cited]);
    expect(findings.map((finding) => finding.code)).toEqual(['X_NEXT_BREAK_UNLISTED']);
    expect(findings[0]?.cause).toContain('wiki/Known-Gaps.md:5');
    expect(findings[0]?.fix).toStartWith('edit scripts/lib/next-breaks-list.ts:1 — ');
    expect(unlistedGaps(gaps, [cited], 'x\nexport const PARKED_BREAKS')[0]?.fix).toContain(':2 — ');
    expect(unlistedGaps(gaps.replace('waits on `next`', 'shipped'), [cited])).toEqual([]);
  });
});

describe('unit · next-breaks · the body', () => {
  test('every break, its change and a link to each line that parked it', () => {
    const body = renderBody([{ ...ONE, citations: [{ path: 'docs/plan.md', line: 3 }] }]);
    expect(body).toContain('| Z1 | a thing goes | the thing is gone |');
    expect(body).toContain(
      '[docs/plan.md:3](https://github.com/developerz-ai/ultimate/blob/main/docs/plan.md#L3)',
    );
    expect(body).toContain('bun run scripts/next-breaks.ts');
  });
});

describe('unit · next-breaks · the real tree', () => {
  test('every parked break resolves, and neither the ledger nor a source tag parks one unlisted', async () => {
    const result = await nextBreaks(repoRoot());
    expect(result.findings).toEqual([]);
    expect(result.title).toBe(NEXT_TRACKING_TITLE);
    for (const parked of PARKED_BREAKS) expect(result.body).toContain(`| ${parked.ids} |`);
  });
});
