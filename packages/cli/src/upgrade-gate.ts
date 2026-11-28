// A hop's gate, run by the CLI the hop just installed: codemods, manifest, doctor, missing guards,
// a Bun-floor hop's coverage, exercise, verify, a stale coverage floor raised (`upgrade-gate-*`,
// `upgrade-guards.ts`, `upgrade-coverage-ratchet.ts`). Never in this process: the installed CLI may
// be majors older, so each answer is a foreign document (`local-cli.ts`); unparsed is never green.

// why: Bun exposes no path-join primitive; the installed bin is assembled from the app root.
import { join } from 'node:path';
import { t } from '@ultimat3/schema';
import { supersededFindings } from './doctor-superseded';
import type { ExecResult, Runner } from './exec';
import { execOutput } from './exec';
import { exerciseReportStamp } from './exercise-floor-report';
import { LOCAL_CLI_BIN } from './local-cli';
import type { CoverageRebaseline, HopCoverage } from './upgrade-coverage';
import { rebaselineCoverage, statedCoverage } from './upgrade-coverage';
import type { HopCoverageRatchet } from './upgrade-coverage-ratchet';
import {
  measuredUnit,
  raiseCoverageFloor,
  rejudgedVerify,
  staleUnitFloor,
} from './upgrade-coverage-ratchet';
import { documentIn } from './upgrade-document';
import type { HopExerciseFloor } from './upgrade-exercise-floor';
import { ratchetExerciseFloor } from './upgrade-exercise-floor';
import { applyHopCodemods } from './upgrade-gate-codemods';
import type { BaselinedGuard, WithheldGuard } from './upgrade-guards';
import { installMissingGuards } from './upgrade-guards';
import type { HopKit } from './upgrade-kit';
import { readKit } from './upgrade-kit';
import { parseJson } from './upgrade-registry';
import type { HopCodemods } from './upgrade-report-codemods';
import { installedNotRun } from './upgrade-scope';

// Where it always was: `verify-exercise.ts` and `verify-budgets-build.ts` read it from here.
export { documentIn } from './upgrade-document';

const FINDING = t.object({
  code: t.string,
  cause: t.string,
  fix: t.string,
  at: t.optional(t.string),
});
const STEP = t.object({ name: t.string, ok: t.boolean, findings: t.optional(t.array(FINDING)) });
const VERIFY = t.object({
  ok: t.boolean,
  summary: t.string,
  steps: t.optional(t.array(STEP)),
  findings: t.optional(t.array(FINDING)),
});
const MANIFEST = t.object({ ok: t.boolean, findings: t.optional(t.array(FINDING)) });
const REPO_MANIFEST = t.object({ scripts: t.optional(t.record(t.string)) });
const GUARD_MISSING = t.object({ name: t.string, add: t.string });
const GUARD_DIFFERS = t.object({ name: t.string, refresh: t.string });
const DOCTOR = t.object({
  data: t.optional(
    t.object({
      warnings: t.optional(t.array(FINDING)),
      guards: t.optional(
        t.object({
          missing: t.optional(t.array(GUARD_MISSING)),
          differs: t.optional(t.array(GUARD_DIFFERS)),
        }),
      ),
    }),
  ),
});

export interface GateFinding {
  /** The gate step that raised it; absent for one raised outside any step. */
  readonly step?: string;
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
  readonly at?: string;
}

interface RawFinding {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
  readonly at?: string;
}

interface VerifyDocument {
  readonly ok: boolean;
  readonly summary: string;
  readonly steps?: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly findings?: readonly RawFinding[];
  }[];
  readonly findings?: readonly RawFinding[];
}

interface DoctorDocument {
  readonly data?: {
    readonly warnings?: readonly RawFinding[];
    readonly guards?: {
      readonly missing?: readonly { readonly name: string; readonly add: string }[];
      readonly differs?: readonly { readonly name: string; readonly refresh: string }[];
    };
  };
}

export interface HopGuards {
  /** False when the hop's `x doctor` predates the listing: unknown, which is not the same as none. */
  readonly reported: boolean;
  /** Still missing after the hop: the ones it withheld, each with the command that adds it. */
  readonly missing: readonly { readonly name: string; readonly add: string }[];
  /** Held in another form: the app's edit, listed and never touched. */
  readonly differs: readonly { readonly name: string; readonly refresh: string }[];
  /** Written by this hop from the installed release's template; `boundaries` found nothing more. */
  readonly installed: readonly string[];
  /** Not written, with how many findings each would have added (`upgrade-guards.ts`). */
  readonly withheld: readonly WithheldGuard[];
  /**
   * Also in `installed`: kept at its measured count, `guardBaseline` in `x.verify.json`. Absent
   * when none, so `--json` of a hop that baselined nothing is unchanged.
   */
  readonly baselined?: readonly BaselinedGuard[];
}

/**
 * `x exercise`'s findings, listed before the gate: an upgrade spent its commits feeding the
 * exercise one red gate at a time, and each of these fixes pastes as written.
 */
export interface HopExercise {
  /** False when the hop's CLI answered no exercise document (none, or one predating it): unknown. */
  readonly reported: boolean;
  readonly ok: boolean;
  readonly findings: readonly GateFinding[];
}

export interface HopGate {
  /** The codemods the hop applied before anything below judged the tree; null when none were asked. */
  readonly codemods?: HopCodemods | null;
  /** Workarounds the hop's framework made unnecessary, read after the codemods: warnings, never red. */
  readonly superseded?: readonly GateFinding[];
  readonly manifest: { readonly ok: boolean; readonly findings: readonly GateFinding[] };
  /**
   * The installed `x doctor`'s `data.warnings[]`: never red on this major, the next one's red —
   * said by the hop that installed the doctor saying them (`X_VERIFY_STEP_UNFLOORED` among them).
   */
  readonly doctorWarnings: readonly GateFinding[];
  readonly guards: HopGuards;
  /** The managed agent kit the installed CLI wrote (`upgrade-kit.ts`); absent on a gate that ran none. */
  readonly kit?: HopKit;
  /** The coverage floor a Bun-floor hop moved to what it measured; null when none moved. */
  readonly coverage: HopCoverage | null;
  readonly exercise: HopExercise;
  /** The exercise figures the hop wrote into `x.verify.json` as its ratchet; null when none. */
  readonly exerciseFloor: HopExerciseFloor | null;
  /**
   * The coverage floor raised to what the gate's `unit` run measured, on its `X_COVERAGE_FLOOR_STALE`
   * — `verify` is then the verdict with `unit` re-run. Absent when nothing was raised.
   */
  readonly coverageRaised?: HopCoverageRatchet;
  readonly verify: {
    readonly ok: boolean;
    readonly summary: string;
    /** The steps that went red, whether or not they carried a finding. */
    readonly failed: readonly string[];
    readonly findings: readonly GateFinding[];
    /** `x upgrade --only`'s list, as run; absent when the hop ran the full gate. */
    readonly only?: readonly string[];
    /** The gate's steps this hop did NOT run, owed elsewhere (CI); absent beside a full gate. */
    readonly notRun?: readonly string[];
  };
}

const flatten = (document: {
  readonly steps?: VerifyDocument['steps'];
  readonly findings?: readonly RawFinding[];
}): readonly GateFinding[] => [
  ...(document.steps ?? []).flatMap((step) =>
    (step.findings ?? []).map((finding) => ({ step: step.name, ...pick(finding) })),
  ),
  ...(document.findings ?? []).map(pick),
];

/** Named fields only: a finding's `meta` carries structures this report promises nothing about. */
const pick = (finding: RawFinding): RawFinding => ({
  code: finding.code,
  cause: finding.cause,
  fix: finding.fix,
  ...(finding.at === undefined ? {} : { at: finding.at }),
});

const INSTALLED_VERIFY = `bun ${LOCAL_CLI_BIN.replaceAll('\\', '/')} verify --json`;

const unreadable = (result: ExecResult): GateFinding => ({
  code: 'X_UPGRADE_GATE_UNREADABLE',
  cause: `${result.command.slice(2).join(' ')} exited ${String(result.code)} with no JSON report: ${execOutput(result).slice(-800) || 'no output'}`,
  fix: INSTALLED_VERIFY,
});

const readVerify = (result: ExecResult): HopGate['verify'] => {
  const parsed = VERIFY.safeParse(documentIn(result.stdout));
  if (parsed.issues !== undefined) {
    return {
      ok: false,
      summary: `x verify exited ${String(result.code)} with no JSON report`,
      failed: [],
      findings: [unreadable(result)],
    };
  }
  const document = parsed.value as VerifyDocument;
  return {
    // Both have to say so: an exit code of 1 under a document saying `ok` is not a verdict to round up.
    ok: result.ok && document.ok,
    summary: document.summary,
    failed: (document.steps ?? []).filter((step) => !step.ok).map((step) => step.name),
    findings: flatten(document),
  };
};

const readManifest = (result: ExecResult): HopGate['manifest'] => {
  const parsed = MANIFEST.safeParse(documentIn(result.stdout));
  if (parsed.issues !== undefined) return { ok: false, findings: [unreadable(result)] };
  const document = parsed.value as { readonly findings?: readonly RawFinding[] };
  return { ok: result.ok, findings: flatten(document) };
};

/** Read like the manifest, except that no document is `reported: false`, never a finding. */
const readExercise = (result: ExecResult): HopExercise => {
  const parsed = MANIFEST.safeParse(documentIn(result.stdout));
  if (parsed.issues !== undefined) return { reported: false, ok: false, findings: [] };
  const document = parsed.value as {
    readonly ok: boolean;
    readonly findings?: readonly RawFinding[];
  };
  return { reported: true, ok: result.ok && document.ok, findings: flatten(document) };
};

/** A doctor that exits red is normal (a port, an env key); its listing and warnings are read. */
const readDoctor = (result: ExecResult): DoctorDocument['data'] => {
  const parsed = DOCTOR.safeParse(documentIn(result.stdout));
  return parsed.issues === undefined ? (parsed.value as DoctorDocument).data : undefined;
};

const readGuards = (doctor: DoctorDocument['data']): HopGuards => {
  const guards = doctor?.guards;
  if (guards === undefined) {
    return { reported: false, missing: [], differs: [], installed: [], withheld: [] };
  }
  return {
    reported: true,
    missing: guards.missing ?? [],
    differs: guards.differs ?? [],
    installed: [],
    withheld: [],
  };
};

export type HopStage =
  | 'codemods'
  | 'manifest'
  | 'doctor'
  | 'guards'
  | 'kit'
  | 'coverage'
  | 'exercise'
  | 'verify';

/**
 * The gate, in order, each stage told apart by `onStage` so a long gate is not a long silence.
 * `kit` refreshes the managed agent files before `verify` judges them; `guards` runs only when the
 * doctor lists a missing one; `coverage` only on a hop that moved the
 * Bun floor — both before `verify`, so the verdict is the one on the tree the hop leaves.
 */
export async function runHopGate(input: {
  readonly runner: Runner;
  readonly root: string;
  readonly onStage: (stage: HopStage) => void;
  /** Present when the hop moved the Bun floor: what the coverage rebaseline's `why` says. */
  readonly bunMoved?: CoverageRebaseline;
  /** The span whose codemods run first, so every later stage judges the carried-across tree. */
  readonly codemods?: { readonly from: string; readonly to: string };
  /** `x upgrade --only`: verify narrowed to these steps, a strict subset of the gate's. */
  readonly only?: { readonly steps: readonly string[]; readonly notRun: readonly string[] };
}): Promise<HopGate> {
  const { runner, root, onStage } = input;
  const installed = (args: readonly string[]): Promise<ExecResult> =>
    runner([process.execPath, join(root, LOCAL_CLI_BIN), ...args], { cwd: root });
  let codemods: HopCodemods | null = null;
  if (input.codemods !== undefined) {
    onStage('codemods');
    codemods = await applyHopCodemods({ runner, root, ...input.codemods });
  }
  const superseded = (await supersededFindings(root)).map(pick);
  onStage('manifest');
  const manifest = readManifest(await installed(['manifest', '--json']));
  onStage('doctor');
  const doctor = readDoctor(await installed(['doctor', '--json']));
  const doctorWarnings = (doctor?.warnings ?? []).map(pick);
  const listed = readGuards(doctor);
  let guards = listed;
  if (listed.missing.length > 0) {
    onStage('guards');
    const done = await installMissingGuards({ cli: installed, root, missing: listed.missing });
    const still = new Set(done.withheld.map((guard) => guard.name));
    guards = {
      ...listed,
      missing: listed.missing.filter((guard) => still.has(guard.name)),
      ...done,
    };
  }
  // After the codemods deleted the old commands and the guards settled: the kit is the release's.
  onStage('kit');
  const kit = readKit(await installed(['kit', '--json']));
  let coverage: HopCoverage | null = null;
  const stated = input.bunMoved === undefined ? undefined : await statedCoverage(root);
  if (input.bunMoved !== undefined && stated !== undefined) {
    onStage('coverage');
    coverage = await rebaselineCoverage({ cli: installed, root, stated, bun: input.bunMoved });
  }
  // The report's stamp first: only a report this exercise rewrote is ratcheted.
  const stamp = await exerciseReportStamp(root);
  onStage('exercise');
  const exercise = readExercise(await installed(['exercise', '--json']));
  // Before `verify`, from the report that exercise just wrote: the gate judges the figures it holds.
  const exerciseFloor = await ratchetExerciseFloor(root, stamp);
  onStage('verify');
  const { only } = input;
  // The installed gate's own list first: the steps owed to CI are steps that CLI has. None owed
  // (every one of its steps named) is that CLI's full gate, run and reported as one.
  const notRun = only === undefined ? undefined : await installedNotRun(installed, only);
  const full = only === undefined || notRun === undefined || notRun.length === 0;
  const ran = await installed(
    full ? ['verify', '--json'] : ['verify', '--only', only.steps.join(','), '--json'],
  );
  let verify: HopGate['verify'] = full
    ? readVerify(ran)
    : { ...readVerify(ran), only: only.steps, notRun };
  let coverageRaised: HopCoverageRatchet | null = null;
  const measured = staleUnitFloor(verify) ? measuredUnit(ran.stdout) : undefined;
  if (measured !== undefined) coverageRaised = await raiseCoverageFloor(root, measured);
  if (coverageRaised !== null) {
    onStage('coverage');
    const unit = readVerify(await installed(['verify', '--only', 'unit', '--json']));
    verify = rejudgedVerify(verify, unit);
  }
  return {
    codemods,
    superseded,
    manifest,
    doctorWarnings,
    guards,
    kit,
    coverage,
    exercise,
    exerciseFloor,
    ...(coverageRaised === null ? {} : { coverageRaised }),
    verify,
  };
}

/** What a repository with no app can still be asked, in the order an author would run them. */
const REPO_SCRIPTS = ['typecheck', 'test'] as const;

export interface RepoScript {
  readonly name: string;
  /** Null when named and not run: a dry run. */
  readonly ok: boolean | null;
  readonly code?: number;
  readonly output?: string;
}

/** The ones this manifest declares. Read as JSON only after `readManifests` has already parsed it. */
export function repoScripts(manifestText: string): readonly string[] {
  const parsed = REPO_MANIFEST.safeParse(parseJson(manifestText));
  if (parsed.issues !== undefined) return [];
  const declared = (parsed.value as { readonly scripts?: Readonly<Record<string, string>> })
    .scripts;
  return REPO_SCRIPTS.filter((name) => declared !== undefined && Object.hasOwn(declared, name));
}

/** Each declared script, one after the other, red or not: the report owes every answer. */
export async function runRepoScripts(input: {
  readonly runner: Runner;
  readonly root: string;
  readonly names: readonly string[];
  readonly onStage: (stage: string) => void;
}): Promise<readonly RepoScript[]> {
  const ran: RepoScript[] = [];
  for (const name of input.names) {
    input.onStage(name);
    const result = await input.runner([process.execPath, 'run', name], { cwd: input.root });
    ran.push({ name, ok: result.ok, code: result.code, output: execOutput(result).slice(-800) });
  }
  return ran;
}
