#!/usr/bin/env bun
// The `verify` CI job's step summary, bounded: the merged verdict's step table, then its findings
// in order until a byte cap, then a pointer to where the rest is. GitHub refuses a summary over
// 1024 KiB ("upload aborted"), and a red merge rendered whole ran past it, so it was lost entirely.
//
//   bun run scripts/verify-summary.ts <verdict.json> '<pointer, with {shown} and {total}>' [--json]

import { isUltimateError } from '@ultimat3/core';
import { MissingPositionalError } from '../packages/cli/src/errors';
import type { CommandResult, Finding } from '../packages/cli/src/output';
import { renderFinding, renderHuman } from '../packages/cli/src/output';
import { parsePart, VerifyMergeInputError } from '../packages/cli/src/verify-merge';
import type { PartStep } from '../packages/cli/src/verify-part-step';
import { isFinding } from '../packages/cli/src/verify-part-step';
import { parseScriptArgs } from './lib/args';
import { report } from './lib/log';
import { REPO_GATE } from './lib/verify-args';

/** Half GitHub's 1024 KiB: the margin is the job's own title line and any later step's summary. */
export const STEP_SUMMARY_CAP_BYTES = 512 * 1024;

/** One item's share at most, so a single megabyte cause cannot be the reason none is shown. */
const ITEM_CAP_BYTES = 16 * 1024;

/** The line `bun test` prints per failed test — the one part of a suite's output kept here. */
const FAILED_TEST = /^\s*\(fail\)/;

const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).byteLength;

/** At most `limit` UTF-8 bytes, cut at a character boundary — never half a code point. */
function clip(text: string, limit: number): string {
  if (bytes(text) <= limit) return text;
  const ellipsis = '…';
  const cut = encoder.encode(text).subarray(0, Math.max(0, limit - bytes(ellipsis)));
  // A cut through a multi-byte character decodes to U+FFFD; dropped, only whole characters stay.
  return `${new TextDecoder().decode(cut).replace(/\uFFFD+$/, '')}${ellipsis}`;
}

const longestTicks = (text: string): number =>
  Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));

/** A fence longer than any backtick run its body holds, so a quoted fence cannot close it. */
const fenced = (body: string, ticks = longestTicks(body)): string => {
  const fence = '`'.repeat(Math.max(3, ticks + 1));
  return `${fence}text\n${body}\n${fence}`;
};

/** What a summary shows of one step or of the document: text, and how many findings it is. */
interface Item {
  readonly text: string;
  readonly findings: number;
}

/**
 * Every red step's failed tests, ahead of every finding: one step's thousands of findings must not
 * crowd another step's failing test names out of the cap. Each test line names its step.
 */
function failedTestItems(steps: readonly PartStep[]): readonly Item[] {
  return steps
    .filter((step) => !step.ok)
    .flatMap((step) =>
      [...new Set((step.output ?? '').split('\n').filter((line) => FAILED_TEST.test(line)))].map(
        (line) => ({ text: `${step.name}  ${Bun.stripANSI(line).trim()}`, findings: 0 }),
      ),
    );
}

/** A step's findings under its name, in the order the log prints them. */
function findingItems(step: PartStep): readonly Item[] {
  if (step.findings.length === 0) return [];
  return [
    { text: step.name, findings: 0 },
    ...step.findings.map((finding) => ({ text: renderFinding(finding, '  '), findings: 1 })),
  ];
}

/** The document's own `summary` and its top-level `findings` — what no single step owns. */
function documentFacts(text: string): { readonly summary: string; readonly top: Finding[] } {
  const lines = text.trim().split('\n');
  const doc: unknown = JSON.parse(lines[lines.length - 1] ?? '');
  const field = (key: string): unknown =>
    typeof doc === 'object' && doc !== null ? Reflect.get(doc, key) : undefined;
  const summary = field('summary');
  const top = field('findings');
  return {
    summary: typeof summary === 'string' ? summary : '',
    top: Array.isArray(top) ? top.filter(isFinding) : [],
  };
}

/**
 * The summary for a merged verdict (`verify merge --json`'s document), never over
 * `STEP_SUMMARY_CAP_BYTES`. `pointer` closes it with `{shown}` and `{total}` filled in: the
 * workflow says where the rest is, because only it knows its log and its artifacts.
 */
export function renderMergeSummary(text: string, file: string, pointer: string): string {
  // Refuses anything but a verify document, by the same reader and code the merge uses.
  const { steps } = parsePart(file, text, REPO_GATE);
  const { summary, top } = documentFacts(text);
  // The table is the human render's own, over steps stripped of everything that can be large.
  const table: CommandResult = {
    ok: steps.every((step) => step.ok),
    command: 'verify',
    summary,
    steps: steps.map(({ output: _output, warnings: _warnings, ...step }) => ({
      ...step,
      findings: [],
    })),
  };
  const items: readonly Item[] = [
    ...failedTestItems(steps),
    ...steps.flatMap(findingItems),
    ...top.map((finding) => ({ text: renderFinding(finding, '  '), findings: 1 })),
  ];
  const total = items.reduce((sum, item) => sum + item.findings, 0);
  const close = (shown: number): string =>
    pointer.replaceAll('{shown}', String(shown)).replaceAll('{total}', String(total));
  const head = fenced(renderHuman(table));
  // Counted as it grows, never re-rendered per item: a red verdict holds thousands of findings.
  // The pointer is reserved at `total`'s digits, which `shown` can never exceed.
  const fixed = bytes(head) + bytes(close(total)) + '\n\n'.length * 2 + '\n'.length;
  const fenceCost = (ticks: number): number => 2 * Math.max(3, ticks + 1) + 'text\n\n'.length;
  const kept: string[] = [];
  let body = 0;
  let ticks = 0;
  let shown = 0;
  for (const item of items) {
    const line = clip(item.text, ITEM_CAP_BYTES);
    const lineTicks = Math.max(ticks, longestTicks(line));
    const grown = body + bytes(line) + (kept.length === 0 ? 0 : 1);
    if (fixed + grown + fenceCost(lineTicks) > STEP_SUMMARY_CAP_BYTES) break;
    kept.push(line);
    body = grown;
    ticks = lineTicks;
    shown += item.findings;
  }
  const blocks = kept.length === 0 ? [head] : [head, fenced(kept.join('\n'), ticks)];
  return `${[...blocks, close(shown)].join('\n\n')}\n`;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  try {
    const [file, pointer] = args.positionals;
    if (file === undefined || pointer === undefined) {
      throw new MissingPositionalError({
        command: 'verify-summary',
        positional: file === undefined ? 'verdict.json' : 'pointer',
        example: `bun run scripts/verify-summary.ts verdict.json 'shown {shown} of {total}: the rest is in the job log'`,
      });
    }
    const handle = Bun.file(file);
    if (!(await handle.exists())) {
      throw new VerifyMergeInputError({ file, reason: 'does not exist', command: REPO_GATE });
    }
    await Bun.write(Bun.stdout, renderMergeSummary(await handle.text(), file, pointer));
  } catch (error) {
    if (!isUltimateError(error)) throw error;
    const finding = { code: error.code, cause: error.cause, fix: error.fix };
    report(
      { ok: false, script: 'verify-summary', summary: 'refused', findings: [finding] },
      args.json,
    );
  }
}
