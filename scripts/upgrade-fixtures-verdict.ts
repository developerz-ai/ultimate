// One fixture's verdict, pure: `x upgrade --json`'s document read as a foreign answer, every file
// the hop left to a human named, and the coded findings. The plan's bar is ZERO hand edits, so a
// hop that is green but leaves a stale guard or a skipped codemod behind is not yet done.

import type { Finding } from './lib/log';

/** A path the author would have had to open after the hop, and why. */
export interface HandStep {
  readonly path: string;
  /** What raised it: a red step, a guard, the Bun floor, a codemod, a doctor warning. */
  readonly source: string;
  readonly why: string;
  /** True when the gate is red over it; false when the gate is green and it is still owed. */
  readonly required: boolean;
}

export interface CodemodOutcome {
  readonly id: string;
  readonly changed: readonly string[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}

export interface HopReading {
  /** The hop's gate is green: `x verify --json`, run by the installed CLI over the tree it left. */
  readonly green: boolean;
  readonly summary: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly failedSteps: readonly string[];
  /** Null when this CLI's `x upgrade` reports no codemods (the engine predates the run). */
  readonly codemods: readonly CodemodOutcome[] | null;
  readonly handSteps: readonly HandStep[];
  /** A refusal before any gate: the CLI's own top-level findings. */
  readonly refusals: readonly Finding[];
}

type Rec = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const records = (value: unknown): readonly Rec[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const texts = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const asFinding = (value: Rec): Finding | undefined => {
  // A foreign CLI's finding: carried whole, or not at all — never a `fix:` invented here.
  const code = text(value['code']);
  const fix = text(value['fix']);
  if (code === undefined || fix === undefined) return undefined;
  const at = text(value['at']);
  return { code, cause: text(value['cause']) ?? '', fix, ...(at === undefined ? {} : { at }) };
};

/**
 * The CLI's one `--json` document for `command`, out of a run's stdout-then-stderr text: the last
 * line that parses to an object naming that command. Never just the last JSON line — `x upgrade`'s
 * stage heartbeats (`{"upgrade":"verify"}`) and `x verify`'s step lines are JSON on stderr too.
 */
export const commandDocument = (output: string, command: string): Rec | undefined =>
  output
    .split('\n')
    .filter((line) => line.trimStart().startsWith('{'))
    .reverse()
    .map((line): unknown => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .find((parsed): parsed is Rec => isRecord(parsed) && parsed['command'] === command);

/** `data.codemods` in either shape the codemod engine reports: a list, or `{ applied, skipped }`. */
export const readCodemods = (value: unknown): readonly CodemodOutcome[] | null => {
  const list = isRecord(value) ? (value['applied'] ?? value['codemods']) : value;
  if (!Array.isArray(list)) return null;
  return records(list).map((entry) => ({
    id: text(entry['id']) ?? '?',
    changed: texts(entry['changed']),
    skipped: records(entry['skipped']).map((skip) => ({
      path: text(skip['path']) ?? '?',
      reason: text(skip['reason']) ?? '',
    })),
  }));
};

/** Every place the hop's report says a human still has to act, with the file to open. */
export const handStepsOf = (data: Rec, codemods: readonly CodemodOutcome[] | null): HandStep[] => {
  const steps: HandStep[] = [];
  const verify = isRecord(data['verify']) ? data['verify'] : {};
  for (const finding of records(verify['findings'])) {
    const step = text(finding['step']);
    steps.push({
      path: text(finding['at']) ?? `(gate step ${step ?? 'unknown'})`,
      source: `verify${step === undefined ? '' : `:${step}`}`,
      why: `${text(finding['code']) ?? '?'}: ${text(finding['cause']) ?? ''}`,
      required: true,
    });
  }
  const guards = isRecord(data['guards']) ? data['guards'] : {};
  for (const guard of records(guards['differs'])) {
    steps.push({
      path: `guards/${text(guard['name']) ?? '?'}.ts`,
      source: 'guards:differs',
      why: `a vendored guard the release changed: ${text(guard['refresh']) ?? ''}`,
      required: false,
    });
  }
  for (const guard of records(guards['missing'])) {
    steps.push({
      path: `guards/${text(guard['name']) ?? '?'}.ts`,
      source: 'guards:missing',
      why: `a shipped guard the hop withheld: ${text(guard['add']) ?? ''}`,
      required: false,
    });
  }
  const bun = isRecord(data['bun']) ? data['bun'] : {};
  for (const manual of records(bun['manual'])) {
    steps.push({
      path: text(manual['path']) ?? '?',
      source: 'bun:manual',
      why: text(manual['why']) ?? '',
      required: false,
    });
  }
  // The doctor ran before the hop installed what it could: a warning about a guard the hop then
  // wrote is answered, not owed.
  const installed = new Set(texts(guards['installed']).map((name) => `guards/${name}.ts`));
  for (const warning of records(data['doctorWarnings'])) {
    if (installed.has(text(warning['at']) ?? '')) continue;
    steps.push({
      path: text(warning['at']) ?? '(x doctor)',
      source: 'doctor',
      why: `${text(warning['code']) ?? '?'}: ${text(warning['cause']) ?? ''}`,
      required: false,
    });
  }
  for (const codemod of codemods ?? []) {
    for (const skip of codemod.skipped) {
      steps.push({
        path: skip.path,
        source: `codemod:${codemod.id}`,
        why: skip.reason,
        required: false,
      });
    }
  }
  return steps;
};

/** `x upgrade --json`'s whole document, or undefined when the CLI printed none. */
export const readHop = (document: unknown): HopReading | undefined => {
  if (!isRecord(document)) return undefined;
  const data = isRecord(document['data']) ? document['data'] : undefined;
  const refusals = records(document['findings']).flatMap((one) => asFinding(one) ?? []);
  if (data === undefined) {
    return {
      green: false,
      summary: text(document['summary']) ?? 'x upgrade answered no data',
      from: null,
      to: null,
      failedSteps: [],
      codemods: null,
      handSteps: [],
      refusals,
    };
  }
  const verify = isRecord(data['verify']) ? data['verify'] : undefined;
  const codemods = readCodemods(data['codemods']);
  return {
    green: document['ok'] === true && verify?.['ok'] === true,
    summary: text(verify?.['summary']) ?? text(document['summary']) ?? '',
    from: text(data['from']) ?? null,
    to: text(data['to']) ?? null,
    failedSteps: texts(verify?.['failed']),
    codemods,
    handSteps: handStepsOf(data, codemods),
    refusals,
  };
};
