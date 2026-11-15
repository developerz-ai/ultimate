// A fixture run's coded findings and its human lines, pure. Three codes and no fourth: the fixture
// could not be built (nothing about the hop is known), the hop's gate is red or it refused, or it
// is green and still left a file to a human — the plan's bar is zero hand edits, so that is red too.

import type { Finding } from './lib/log';
import type { ScaffoldDrift } from './upgrade-fixtures-drift';
import type { HandStep, HopReading } from './upgrade-fixtures-verdict';

/** The command that reproduces one version's fixture, end to end. */
export const reproduceFixture = (version: string): string =>
  `bun run scripts/upgrade-fixtures.ts --versions ${version} --keep --json`;

export type FixtureStage = 'pack' | 'scaffold' | 'setup' | 'upgrade';

export interface FixtureRun {
  readonly version: string;
  /** The app's root; removed once judged unless `--keep` was given. */
  readonly dir: string;
  /** Set when the fixture never reached the hop: the stage, and its output's tail. */
  readonly unbuilt?: { readonly stage: FixtureStage; readonly output: string };
  /** The gate at the scaffold's own release, before any hop (`--before`); null when not run. */
  readonly before: { readonly green: boolean; readonly summary: string } | null;
  readonly hop?: HopReading;
  /** The hop's output tail, kept only when it printed no `--json` document to read. */
  readonly hopOutput?: string;
  /** `git status --porcelain` paths after the hop: what `x upgrade` wrote, by itself. */
  readonly wrote: readonly string[];
  /** A standalone `bun run verify --json` after the hop (`--verify`); null when not run. */
  readonly after: { readonly green: boolean; readonly summary: string } | null;
  /** The hopped app against HEAD's own scaffold: informational, never a finding on its own. */
  readonly drift: ScaffoldDrift | null;
  readonly ms: number;
  /** Wall time per stage reached — scaffold, setup, before, hop, after — in milliseconds. */
  readonly stages: Readonly<Record<string, number>>;
}

const listed = (steps: readonly HandStep[]): string =>
  [...new Set(steps.map((step) => step.path))].slice(0, 12).join(', ');

/** Every finding one fixture raises, in the order an author would meet them. */
export const fixtureFindings = (run: FixtureRun): readonly Finding[] => {
  const fix = reproduceFixture(run.version);
  if (run.unbuilt !== undefined) {
    return [
      {
        code: 'X_UPGRADE_FIXTURE_UNBUILT',
        cause: `the ${run.version} fixture stopped at ${run.unbuilt.stage}, so nothing is known about its hop: ${run.unbuilt.output.slice(-600)}`,
        fix,
        at: run.dir,
      },
    ];
  }
  const hop = run.hop;
  if (hop === undefined || !hop.green || (run.after !== null && !run.after.green)) {
    const why =
      hop === undefined
        ? `x upgrade printed no JSON document: ${run.hopOutput ?? ''}`
        : hop.refusals.length > 0
          ? `x upgrade refused: ${hop.refusals.map((one) => `${one.code} ${one.cause}`).join('; ')}`
          : `the gate after the hop is red (${hop.failedSteps.join(', ') || hop.summary})`;
    const findings: Finding[] = [
      {
        code: 'X_UPGRADE_FIXTURE_RED',
        cause: `${run.version} → HEAD: ${why}${run.after !== null && !run.after.green ? `; a standalone x verify says: ${run.after.summary}` : ''}`,
        fix,
        at: run.dir,
      },
    ];
    const required = (hop?.handSteps ?? []).filter((step) => step.required);
    if (required.length > 0) {
      findings.push({
        code: 'X_UPGRADE_FIXTURE_HAND_STEP',
        cause: `${run.version} → HEAD: to go green an author would edit ${listed(required)}`,
        fix,
        at: run.dir,
      });
    }
    return findings;
  }
  const owed = hop.handSteps.filter((step) => !step.required);
  if (owed.length === 0) return [];
  return [
    {
      code: 'X_UPGRADE_FIXTURE_HAND_STEP',
      cause: `${run.version} → HEAD is green, and still leaves ${String(owed.length)} item(s) to a human: ${listed(owed)}`,
      fix,
      at: run.dir,
    },
  ];
};

/** One block per version for the human render. */
export const fixtureLines = (run: FixtureRun): readonly string[] => {
  const laps = Object.entries(run.stages)
    .map(([stage, ms]) => `${stage} ${String(Math.round(ms / 1000))}s`)
    .join(', ');
  const head = `${run.version} → ${run.hop?.to ?? 'HEAD'}  (${String(Math.round(run.ms / 1000))}s: ${laps})`;
  if (run.unbuilt !== undefined) return [`✗ ${head}: unbuilt at ${run.unbuilt.stage}`];
  const lines = [
    `${run.hop?.green === true ? '✓' : '✗'} ${head}: ${run.hop?.summary ?? 'no report'}`,
  ];
  if (run.before !== null) lines.push(`    before the hop: ${run.before.summary}`);
  const codemods = run.hop?.codemods;
  lines.push(
    codemods === null || codemods === undefined
      ? '    codemods: not reported by this x upgrade'
      : `    codemods: ${codemods.map((one) => `${one.id} (${String(one.changed.length)} changed, ${String(one.skipped.length)} skipped)`).join(', ') || 'none applied'}`,
  );
  lines.push(`    x upgrade wrote ${String(run.wrote.length)} file(s)`);
  for (const step of run.hop?.handSteps ?? []) {
    lines.push(
      `    ${step.required ? 'must edit' : 'owed'}  ${step.path}  [${step.source}] ${step.why}`,
    );
  }
  if (run.after !== null) lines.push(`    standalone x verify: ${run.after.summary}`);
  if (run.drift !== null) {
    const { missing, differs, extra } = run.drift;
    lines.push(
      `    against HEAD's x new: ${String(missing.length)} missing, ${String(differs.length)} differ, ${String(extra.length)} extra`,
    );
  }
  return lines;
};
