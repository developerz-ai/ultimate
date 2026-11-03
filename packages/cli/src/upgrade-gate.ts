// A hop's gate, run by the CLI the hop just installed: `x manifest`, `x doctor --json`, `x verify
// --json`. Never in this process, because the installed CLI is the one that knows the installed
// framework (`local-cli.ts`), and it may be many majors older than this one: each answer is read as
// a foreign document, and one that will not parse is a finding, never a green.

// why: Bun exposes no path-join primitive; the installed bin is assembled from the app root.
import { join } from 'node:path';
import { t } from '@ultimat3/schema';
import type { ExecResult, Runner } from './exec';
import { execOutput } from './exec';
import { LOCAL_CLI_BIN } from './local-cli';
import { parseJson } from './upgrade-registry';

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
    readonly guards?: {
      readonly missing?: readonly { readonly name: string; readonly add: string }[];
      readonly differs?: readonly { readonly name: string; readonly refresh: string }[];
    };
  };
}

export interface HopGuards {
  /** False when the hop's `x doctor` predates the listing: unknown, which is not the same as none. */
  readonly reported: boolean;
  readonly missing: readonly { readonly name: string; readonly add: string }[];
  readonly differs: readonly { readonly name: string; readonly refresh: string }[];
}

export interface HopGate {
  readonly manifest: { readonly ok: boolean; readonly findings: readonly GateFinding[] };
  readonly guards: HopGuards;
  readonly verify: {
    readonly ok: boolean;
    readonly summary: string;
    /** The steps that went red, whether or not they carried a finding. */
    readonly failed: readonly string[];
    readonly findings: readonly GateFinding[];
  };
}

/**
 * The one JSON document on a child's stdout. Whole first; then its last line that parses, because
 * the CLI that keeps fd 1 to one document under `--json` is a recent one and a hop can install one
 * that still logs a boot line ahead of it.
 */
export function documentIn(stdout: string): unknown {
  const whole = parseJson(stdout.trim());
  if (whole !== undefined) return whole;
  const lines = stdout.split('\n').filter((line) => line.trimStart().startsWith('{'));
  return lines
    .reverse()
    .map(parseJson)
    .find((parsed) => parsed !== undefined);
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

/** A doctor that exits red is normal (a port, an env key); only its listing is read here. */
const readGuards = (result: ExecResult): HopGuards => {
  const parsed = DOCTOR.safeParse(documentIn(result.stdout));
  const guards =
    parsed.issues === undefined ? (parsed.value as DoctorDocument).data?.guards : undefined;
  if (guards === undefined) return { reported: false, missing: [], differs: [] };
  return { reported: true, missing: guards.missing ?? [], differs: guards.differs ?? [] };
};

/** The three, in order, each told apart by `onStage` so a long gate is not a long silence. */
export async function runHopGate(input: {
  readonly runner: Runner;
  readonly root: string;
  readonly onStage: (stage: 'manifest' | 'doctor' | 'verify') => void;
}): Promise<HopGate> {
  const { runner, root, onStage } = input;
  const installed = (args: readonly string[]): Promise<ExecResult> =>
    runner([process.execPath, join(root, LOCAL_CLI_BIN), ...args], { cwd: root });
  onStage('manifest');
  const manifest = readManifest(await installed(['manifest', '--json']));
  onStage('doctor');
  const guards = readGuards(await installed(['doctor', '--json']));
  onStage('verify');
  const verify = readVerify(await installed(['verify', '--json']));
  return { manifest, guards, verify };
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
