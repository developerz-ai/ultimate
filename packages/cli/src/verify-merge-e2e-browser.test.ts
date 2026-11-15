// The browser verdict on a SPLIT e2e step: each shard defers it (one shard holding only browser
// tests ran nothing, while its sibling ran), and `x verify merge` judges it on the summed counts,
// carried from the shard that found no browser — the machine that knows, never the merging one.

import { describe, expect, test } from 'bun:test';
import { E2E_BROWSER_MISSING, e2eBrowserMissingFinding, e2eBrowserWarning } from './verify-e2e';
import type { VerifyPart } from './verify-merge';
import { mergeParts } from './verify-merge';
import { shardFiles } from './verify-shard';

const FILES = ['a.e2e.test.ts', 'b.e2e.test.ts'];
const missing = e2eBrowserMissingFinding({ CHROME_PATH: '/nonexistent/chrome' }, 'linux');

/** One e2e shard as `x verify --shard i/2 --json` reports it on a machine with no browser. */
const e2eShard = (index: number, ran: number): VerifyPart => ({
  file: `e2e-${String(index)}.json`,
  durationMs: 10,
  steps: [
    {
      name: 'e2e',
      ok: true,
      durationMs: 10,
      skipped: false,
      findings: [],
      tests: { ran, skipped: 2 },
      ...(ran === 0 ? { warnings: [e2eBrowserWarning(missing)] } : {}),
      shard: shardFiles(FILES, { index, total: 2 }),
    },
  ],
});

const floor = { steps: ['e2e'], problems: [] };
const e2eOf = (result: ReturnType<typeof mergeParts>) =>
  (result.steps ?? []).find((step) => step.name === 'e2e');

describe('unit · x verify merge · the e2e browser verdict on the sum', () => {
  test('one shard ran nothing, its sibling ran: the merged e2e step is green', () => {
    const result = mergeParts([e2eShard(1, 0), e2eShard(2, 3)], floor, ['e2e']);
    expect(e2eOf(result)?.ok).toBe(true);
    expect(result.ok).toBe(true);
  });

  test('every shard ran nothing for want of a browser: red, the browser code first', () => {
    const result = mergeParts([e2eShard(1, 0), e2eShard(2, 0)], floor, ['e2e']);
    expect(result.ok).toBe(false);
    const findings = e2eOf(result)?.findings ?? [];
    expect(findings[0]?.code).toBe(E2E_BROWSER_MISSING);
    expect(findings[0]?.fix).toBe(missing.fix);
    expect(findings[0]?.cause).toBe(missing.cause);
    expect(findings.map((finding) => finding.code)).toContain('X_VERIFY_SUITE_VANISHED');
  });

  test('e2e not in the floor: nothing ran is a skip, never the browser code', () => {
    const result = mergeParts([e2eShard(1, 0), e2eShard(2, 0)], { steps: [], problems: [] }, [
      'e2e',
    ]);
    expect((e2eOf(result)?.findings ?? []).map((finding) => finding.code)).not.toContain(
      E2E_BROWSER_MISSING,
    );
  });
});
