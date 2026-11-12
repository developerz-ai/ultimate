#!/usr/bin/env bun
// Derive the three inventories that prose restates and reject stale or absent claims, so a source
// change cannot silently leave the repository map and public documentation describing old shapes.
//
//   bun run scripts/derived-doc-counts.ts [--json]

// why: a path may name a directory, and `Bun.file().exists()` answers for files only.
import { existsSync } from 'node:fs';
import { parseComponents } from '../packages/ui/src/catalog/parse-component';
import { readDocPages } from './doc-commands';
import { parseScriptArgs } from './lib/args';
import type { MarkdownFile } from './lib/doc-citations';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { lineOf } from './lib/source-scan';

export interface DerivedDocCounts {
  readonly components: number;
  readonly seamRows: number;
  readonly pipelineStages: number;
}

/**
 * A stale claim names the line it is written on, so a fix can open the page there; a page that
 * states no claim has no line to open, and its fix names the page alone.
 */
export type DerivedDocCountGap =
  | {
      readonly kind: keyof DerivedDocCounts;
      readonly at: string;
      readonly claimed: number;
      /** 1-based line of the claim in the page. */
      readonly line: number;
    }
  | {
      readonly kind: keyof DerivedDocCounts;
      readonly at: string;
      readonly claimed?: undefined;
      readonly line?: undefined;
    };

const CLAIMS: Readonly<Record<keyof DerivedDocCounts, readonly [string, RegExp][]>> = {
  components: [
    ['docs/idea/16-app-targets.md', /\b(\d+)\s+(?:source-derived\s+)?UI components\b/gi],
    ['wiki/Home.md', /\b(\d+)\s+(?:source-derived\s+)?UI components\b/gi],
    ['llms.txt', /\b(\d+)\s+(?:source-derived\s+)?UI components\b/gi],
  ],
  seamRows: [
    ['wiki/Home.md', /\b(\d+)\s+seam rows\b[^\n]*\bshipped\b/gi],
    ['llms.txt', /\b(\d+)\s+seam rows\b[^\n]*\bshipped\b/gi],
    ['docs/idea/README.md', /\b(\d+)\s+seam rows\b[^\n]*\bshipped\b/gi],
  ],
  pipelineStages: [
    ['docs/architecture/README.md', /\b(\d+)\s+ordered stages\b/gi],
    ['llms.txt', /\b(\d+)\s+ordered stages\b/gi],
  ],
};

/** Source-derived facts; each parser is intentionally adjacent to the artifact it counts. */
export async function deriveDocCounts(root: string): Promise<DerivedDocCounts> {
  // This rule runs inside `frameworkFiles` (scripts/verify.ts), over whatever root it is handed —
  // including a fixture tree with none of these sources, where a throw is a stack trace, not a
  // finding. An absent source derives zero, and the claims then convict the tree — STALE against
  // zero, or UNSCANNED when the claiming page is absent too — never silence.
  const components = `${root}/packages/ui/src/components`;
  // The inventory is the components, not the files that hold them: one file may export two
  // components (`LineChart.tsx`) and another none (`heading-node.tsx`), so a file count and a
  // component count agree only by accident. The catalog's own parser decides which is which.
  let componentCount = 0;
  if (existsSync(components)) {
    for await (const file of new Bun.Glob('*.tsx').scan({ cwd: components })) {
      const source = await Bun.file(`${components}/${file}`).text();
      componentCount += parseComponents(source).length;
    }
  }
  const ladderFile = Bun.file(`${root}/docs/idea/17-scale-ladder.md`);
  const ladder = (await ladderFile.exists()) ? await ladderFile.text() : '';
  const seamRows = ladder
    .split('\n')
    .filter((line) => /^\|/.test(line))
    .filter((line) => /\|\s*shipped(?:\s|,|\|)/i.test(line)).length;
  const pipelineFile = Bun.file(`${root}/packages/http/src/pipeline.ts`);
  const pipeline = (await pipelineFile.exists()) ? await pipelineFile.text() : '';
  const pipelineBlock = pipeline.match(/PIPELINE_STAGES[^=]*=\s*\[([\s\S]*?)\n\];/);
  const pipelineStages = [...(pipelineBlock?.[1]?.matchAll(/\bname:\s*'/g) ?? [])].length;
  return { components: componentCount, seamRows, pipelineStages };
}

export function checkDerivedDocCounts(
  pages: readonly MarkdownFile[],
  counts: DerivedDocCounts,
): readonly DerivedDocCountGap[] {
  const byPath = new Map(pages.map((page) => [page.path, page.text]));
  const gaps: DerivedDocCountGap[] = [];
  for (const [kind, checks] of Object.entries(CLAIMS) as readonly [
    keyof DerivedDocCounts,
    readonly [string, RegExp][],
  ][]) {
    // Per declared (kind, path) pair: a path whose prose no longer matches is a silent hole —
    // nothing in it is scanned, so a rephrased claim there can never go stale. Name the path.
    for (const [path, expression] of checks) {
      const text = byPath.get(path) ?? '';
      let claims = 0;
      for (const match of text.matchAll(expression)) {
        claims += 1;
        const claimed = Number.parseInt(match[1] ?? '', 10);
        // The line of the claim, so a fix can open the page where the stale number is written.
        if (claimed !== counts[kind]) {
          gaps.push({ kind, at: path, claimed, line: lineOf(text, match.index) });
        }
      }
      if (claims === 0) gaps.push({ kind, at: path });
    }
  }
  return gaps;
}

export const derivedDocCountFindingFor = (
  gap: DerivedDocCountGap,
  counts: DerivedDocCounts,
): Finding => {
  const expected = counts[gap.kind];
  if (gap.claimed === undefined) {
    return {
      code: 'X_DERIVED_DOC_COUNT_UNSCANNED',
      cause: `no current-prose claim for ${gap.kind} matched the derived documentation-count scan`,
      // No claim, so no line to open: the fix names the page, then the edit, then the re-run. A
      // line that opened with the re-run pastes a command that convicts the same tree again.
      fix: `${gap.at} — state the derived ${gap.kind} count (${String(expected)}) in the phrasing its CLAIMS entry matches; then bun run scripts/derived-doc-counts.ts --json`,
      at: gap.at,
    };
  }
  return {
    code: 'X_DERIVED_DOC_COUNT_STALE',
    cause: `${gap.at} states ${String(gap.claimed)} ${gap.kind}, but the source-derived inventory is ${String(expected)}`,
    // The edit leads and the re-run follows: a pasted fix that ran the check first would convict
    // the same page again.
    fix: `edit ${gap.at}:${String(gap.line)} — write ${String(expected)} where it states ${String(gap.claimed)} for ${gap.kind}, or correct the source inventory; then bun run scripts/derived-doc-counts.ts --json`,
    at: gap.at,
  };
};

export const derivedDocCountFindings = async (root: string): Promise<readonly Finding[]> => {
  const [pages, counts] = await Promise.all([readDocPages(root), deriveDocCounts(root)]);
  return checkDerivedDocCounts(pages, counts).map((gap) => derivedDocCountFindingFor(gap, counts));
};

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const [counts, pages] = await Promise.all([deriveDocCounts(root), readDocPages(root)]);
  const gaps = checkDerivedDocCounts(pages, counts);
  report(
    {
      ok: gaps.length === 0,
      script: 'derived-doc-counts',
      summary:
        gaps.length === 0
          ? `derived documentation counts match (${String(counts.components)} components, ${String(counts.seamRows)} seam rows, ${String(counts.pipelineStages)} pipeline stages)`
          : `${String(gaps.length)} derived documentation count claim(s) are stale or unscanned`,
      findings: gaps.map((gap) => derivedDocCountFindingFor(gap, counts)),
    },
    args.json,
  );
}
