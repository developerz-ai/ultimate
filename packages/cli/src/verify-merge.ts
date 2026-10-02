// `x verify merge <part.json…>`: n CI jobs' `x verify --only … [--shard i/n] --json` documents
// back into ONE gate verdict. Green only when the parts are provably the whole gate:
//
// - every step of `VERIFY_STEP_NAMES` reported by exactly one part — or, for a sharded step, by
//   shards 1..n exactly once each, all counting the same corpus (`corpusHash`);
// - the zero-tests floor applied to the SUMMED counts of a sharded step, which each shard deferred;
// - any gap is a named `X_VERIFY_MERGE_INCOMPLETE` finding, never a silent pass.
//
// - an app's coverage floor judged HERE for a sharded `unit` step: one shard's slice cannot hold a
//   floor, so each hands its facts over in its document and the fold is judged once.
//
// The merged document is a gate run (no `notAGateRun`), because the question it answers — did
// every step run, over the whole tree, and pass — is the gate's question.

// why: Bun ships no synchronous existence check and no path-join primitive.
import { existsSync } from 'node:fs';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { ERROR_DOCS_URL, renderThrowable } from '@ultimat3/core';
import { APP_CONFIG_FILE } from './app-root';
import { judgeCoverage } from './coverage-floor';
import type { CoverageMap } from './coverage-lcov';
import { decodeCoverage, mergeCoverage } from './coverage-lcov';
import { msg } from './messages';
import type { CommandResult, Finding, StepResult } from './output';
import type { TestCounts } from './test-counts';
import { VerifyMergeInputError } from './verify-errors';
import type { VerifyFloor } from './verify-floor';
import { floorRequires, skippedSuiteFinding } from './verify-floor';
import { verifySummary } from './verify-run';
import { GATE_COMMAND, VERIFY_STEP_NAMES } from './verify-step';

interface PartStep {
  readonly name: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly skipped: boolean;
  readonly findings: readonly Finding[];
  readonly workers?: number;
  readonly tests?: TestCounts;
  readonly output?: string;
  readonly shard?: {
    readonly index: number;
    readonly total: number;
    readonly corpusHash: string;
    readonly files: readonly string[];
  };
}

export interface VerifyPart {
  readonly file: string;
  readonly durationMs: number;
  readonly steps: readonly PartStep[];
  /** step → what this part's slice of it covered and did not judge (`data.coverage.<step>.facts`). */
  readonly coverage?: Readonly<Record<string, CoverageMap>>;
}

/** Findings a step earns from the parts TOGETHER, which no one part could raise. */
export type MergeRiders = Readonly<
  Record<string, { readonly findings: readonly Finding[]; readonly output?: string }>
>;

export interface MergeOptions {
  /** The gate as invoked here, for the `fix:` of a gap. */
  readonly command?: string;
  readonly riders?: MergeRiders;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The LAST non-empty line that parses: `bin/check --json` prints the build's document and then
 * the gate's, and a reader takes the last one.
 */
export function parsePart(file: string, text: string, command: string = GATE_COMMAND): VerifyPart {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) throw new VerifyMergeInputError({ file, reason: 'is empty', command });
  let doc: unknown;
  try {
    doc = JSON.parse(lines[lines.length - 1] as string);
  } catch (error) {
    throw new VerifyMergeInputError({
      file,
      reason: `does not end in a JSON document (${renderThrowable(error)})`,
      sourceError: error,
      command,
    });
  }
  if (!isRecord(doc) || doc['command'] !== 'verify' || !Array.isArray(doc['steps'])) {
    throw new VerifyMergeInputError({
      file,
      reason: 'is not an x verify --json document (no "command": "verify" with "steps")',
      command,
    });
  }
  const data = isRecord(doc['data']) ? doc['data'] : {};
  const steps: PartStep[] = [];
  for (const raw of doc['steps'] as unknown[]) {
    if (!isRecord(raw) || typeof raw['name'] !== 'string' || typeof raw['ok'] !== 'boolean') {
      throw new VerifyMergeInputError({
        file,
        reason: 'holds a step without a name and ok',
        command,
      });
    }
    steps.push(raw as unknown as PartStep);
  }
  const coverage = new Map<string, CoverageMap>();
  for (const [step, entry] of Object.entries(isRecord(data['coverage']) ? data['coverage'] : {})) {
    // A part that judged its own floor carries numbers, not facts: nothing here to fold.
    if (!isRecord(entry) || !('facts' in entry)) continue;
    const map = decodeCoverage(entry['facts']);
    if (map === undefined) {
      throw new VerifyMergeInputError({
        file,
        reason: `carries coverage for "${step}" that is not a coverage map`,
        command,
      });
    }
    coverage.set(step, map);
  }
  return {
    file,
    durationMs: typeof data['durationMs'] === 'number' ? data['durationMs'] : 0,
    steps,
    ...(coverage.size === 0 ? {} : { coverage: Object.fromEntries(coverage) }),
  };
}

/** A gap finding, with a fix spelled for the entry that raised it. */
type Gap = (cause: string, at?: string) => Finding;

const gapFor =
  (command: string): Gap =>
  (cause, at) => ({
    code: 'X_VERIFY_MERGE_INCOMPLETE',
    cause,
    fix: `${command} merge parts/*.json --json   # after every CI job uploaded its part`,
    docs: ERROR_DOCS_URL,
    ...(at === undefined ? {} : { at }),
  });

/** The step every part's coverage facts belong to. */
const COVERED_STEP = 'unit';

/**
 * An app's coverage floor over a SHARDED `unit` step, judged once on the fold of every shard —
 * the finding no shard could raise alone. Nothing when the step was not split (the whole run
 * judged itself), when a shard is red (a failed slice wrote no lcov, and its own finding is the
 * one to read), or outside an app. Shards that carry no facts at all fold to an empty map, which
 * is 0% and a red gate: a split can never skip the floor by saying nothing.
 */
export async function coverageRiders(
  parts: readonly VerifyPart[],
  root: string,
  floor: VerifyFloor | undefined,
): Promise<MergeRiders> {
  if (!existsSync(join(root, APP_CONFIG_FILE))) return {};
  const shards = parts.flatMap((part) =>
    part.steps
      .filter((step) => step.name === COVERED_STEP && step.shard !== undefined)
      .map((step) => ({ step, coverage: part.coverage?.[COVERED_STEP] })),
  );
  if (shards.length === 0 || shards.some((shard) => !shard.step.ok)) return {};
  const folded = mergeCoverage(
    shards.flatMap((shard) => (shard.coverage === undefined ? [] : [shard.coverage])),
  );
  const verdict = await judgeCoverage(root, folded, floor?.coverage);
  return { [COVERED_STEP]: { findings: verdict.findings, output: verdict.output } };
}

const sumCounts = (steps: readonly PartStep[]): TestCounts | undefined => {
  const counted = steps.filter((step) => step.tests !== undefined);
  if (counted.length === 0) return undefined;
  const errors = counted.reduce((sum, step) => sum + (step.tests?.errors ?? 0), 0);
  return {
    ran: counted.reduce((sum, step) => sum + (step.tests?.ran ?? 0), 0),
    skipped: counted.reduce((sum, step) => sum + (step.tests?.skipped ?? 0), 0),
    ...(errors === 0 ? {} : { errors }),
  };
};

/** One step's entries from every part, folded into one step result and its gaps. */
function mergeStep(
  name: string,
  entries: readonly { readonly part: string; readonly step: PartStep }[],
  floor: VerifyFloor | undefined,
  gap: Gap,
  rider: MergeRiders[string] | undefined,
): StepResult {
  if (entries.length === 0) {
    return {
      name,
      ok: false,
      durationMs: 0,
      findings: [gap(`step "${name}" is in no part — no CI job ran it`, name)],
    };
  }
  const sharded = entries.filter((entry) => entry.step.shard !== undefined);
  const whole = entries.filter((entry) => entry.step.shard === undefined);
  const gaps: Finding[] = [];
  if (whole.length > 1 || (whole.length > 0 && sharded.length > 0)) {
    gaps.push(
      gap(
        `step "${name}" is reported by ${String(entries.length)} parts (${entries
          .map((entry) => entry.part)
          .join(', ')}) — each step belongs to one job, or to one full set of shards`,
        name,
      ),
    );
  }
  if (sharded.length > 0) {
    const totals = new Set(sharded.map((entry) => entry.step.shard?.total));
    const hashes = new Set(sharded.map((entry) => entry.step.shard?.corpusHash));
    if (totals.size > 1) {
      gaps.push(gap(`step "${name}" mixes splits of ${[...totals].join(' and ')} shards`, name));
    }
    if (hashes.size > 1) {
      gaps.push(
        gap(
          `step "${name}"'s shards counted ${String(hashes.size)} different corpora — every job must check out the same commit`,
          name,
        ),
      );
    }
    const total = Math.max(...sharded.map((entry) => entry.step.shard?.total ?? 0));
    const seen = new Map<number, number>();
    for (const entry of sharded) {
      const index = entry.step.shard?.index ?? 0;
      seen.set(index, (seen.get(index) ?? 0) + 1);
    }
    const missing = Array.from({ length: total }, (_, i) => i + 1).filter((i) => !seen.has(i));
    const doubled = [...seen].filter(([, count]) => count > 1).map(([index]) => index);
    if (missing.length > 0) {
      gaps.push(
        gap(
          `step "${name}" is missing shard(s) ${missing.map((i) => `${String(i)}/${String(total)}`).join(', ')}`,
          name,
        ),
      );
    }
    if (doubled.length > 0) {
      gaps.push(gap(`step "${name}" has shard(s) ${doubled.join(', ')} more than once`, name));
    }
  }
  const steps = entries.map((entry) => entry.step);
  const tests = sumCounts(steps);
  // The floor each shard deferred, on the summed counts: a split step whose shards together ran
  // nothing is the same vanished suite a whole run that ran nothing is.
  const nothingRan = sharded.length > 0 && tests !== undefined && tests.ran === 0;
  const required = floorRequires(floor, name);
  const floorGap = nothingRan && required ? [skippedSuiteFinding(name, tests.skipped)] : [];
  const riding = rider?.findings ?? [];
  const findings = [...steps.flatMap((step) => step.findings), ...gaps, ...floorGap, ...riding];
  const output = [
    ...steps
      .filter((step) => !step.ok && step.output !== undefined && step.output.length > 0)
      .map((step) => step.output as string),
    ...(rider?.output === undefined ? [] : [rider.output]),
  ].join('\n');
  const skipped =
    sharded.length > 0 ? nothingRan && !required : steps.every((step) => step.skipped);
  return {
    name,
    ok:
      steps.every((step) => step.ok) &&
      gaps.length === 0 &&
      floorGap.length === 0 &&
      riding.length === 0,
    // The slowest job: the parts ran side by side, and wall time is what a CI run waits on.
    durationMs: Math.max(...steps.map((step) => step.durationMs)),
    ...(skipped ? { skipped: true } : {}),
    findings,
    ...(output.length === 0 ? {} : { output }),
    ...(tests === undefined ? {} : { tests }),
  };
}

/** The gate verdict n parts add up to. */
export function mergeParts(
  parts: readonly VerifyPart[],
  floor: VerifyFloor | undefined,
  declared: readonly string[] = VERIFY_STEP_NAMES,
  options: MergeOptions = {},
): CommandResult {
  const gap = gapFor(options.command ?? GATE_COMMAND);
  const unknown = parts.flatMap((part) =>
    part.steps
      .filter((step) => !declared.includes(step.name))
      .map((step) => gap(`${part.file} reports "${step.name}", which x verify does not run`)),
  );
  const steps = declared.map((name) =>
    mergeStep(
      name,
      parts.flatMap((part) =>
        part.steps.filter((step) => step.name === name).map((step) => ({ part: part.file, step })),
      ),
      floor,
      gap,
      options.riders !== undefined && Object.hasOwn(options.riders, name)
        ? options.riders[name]
        : undefined,
    ),
  );
  const failed = steps.filter((step) => !step.ok).map((step) => step.name);
  const skipped = steps.filter((step) => step.skipped === true).map((step) => step.name);
  const durationMs = Math.max(0, ...parts.map((part) => part.durationMs));
  const ok = failed.length === 0 && unknown.length === 0;
  const summary = verifySummary({ results: steps, failed, skipped, totalMs: durationMs });
  return {
    ok,
    command: 'verify',
    summary: msg('cli.verify.merged', { parts: parts.length, summary }),
    steps,
    ...(unknown.length === 0 ? {} : { findings: unknown }),
    data: {
      failed,
      skipped,
      durationMs,
      merged: { parts: parts.map((part) => part.file) },
    },
    exitCode: ok ? 0 : 1,
  };
}
