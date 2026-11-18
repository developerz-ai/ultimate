// The finished row "the gate is whole": every tracked app (`GATED_APPS`) pins no red step and its
// `x.verify.json` asserts every step `x verify` has, strictly. The one step an app cannot run is
// `roadmap` — it reads this repository's own roadmap — so it is the one skip read as whole.

import { renderFixShellArg } from '../packages/core/src/error-render';
import { isJsonObject } from '../packages/core/src/json-object';
import type { FinishedRow } from './finished-rule';
import { green, red } from './finished-rule';
import type { Finding } from './lib/log';

/** Steps that check the framework repository itself, which no app carries. */
export const FRAMEWORK_ONLY_STEPS: readonly string[] = ['roadmap'];
const PINS_FILE = 'scripts/lib/gated-apps.ts';

export interface GatedAppRead {
  readonly dir: string;
  readonly expectedRed: Readonly<Record<string, string>>;
  /** The parsed `<dir>/x.verify.json`, or `undefined` when it is missing or not JSON. */
  readonly floor: unknown;
}

const stringsAt = (value: unknown, key: string): readonly string[] => {
  const field = isJsonObject(value) ? value[key] : undefined;
  if (Array.isArray(field)) return field.filter((one) => typeof one === 'string');
  return isJsonObject(field) ? Object.keys(field) : [];
};

function appFindings(app: GatedAppRead, stepNames: readonly string[]): readonly Finding[] {
  const floorFile = `${app.dir}/x.verify.json`;
  // A path or step spliced into a command is screened: a fix line is pasted into a shell.
  const dir = renderFixShellArg(app.dir, '<dir>');
  const findings: Finding[] = Object.keys(app.expectedRed).map((step) => ({
    code: 'X_FINISHED_GATE_PARTIAL',
    cause: `${app.dir} pins its ${step} step red in GATED_APPS, so the gate it passes is not the whole gate`,
    fix: `bun run scripts/reference-app-gate.ts --app ${dir} --json   # make ${step} green, then: bun run scripts/reference-app-gate.ts --unpin ${dir}:${renderFixShellArg(step, '<step>')}`,
    at: PINS_FILE,
  }));
  if (!isJsonObject(app.floor)) {
    return [
      ...findings,
      {
        code: 'X_FINISHED_GATE_PARTIAL',
        cause: `${floorFile} is missing or not a JSON object, so which steps ${app.dir} asserts cannot be read`,
        fix: `bun run x -- verify --cwd ${dir} --json   # then restore ${floorFile} from git history`,
        at: floorFile,
      },
    ];
  }
  const asserted = new Set(stringsAt(app.floor, 'steps'));
  const skipped = stringsAt(app.floor, 'skip');
  const unasserted = stepNames.filter(
    (step) => !asserted.has(step) && !FRAMEWORK_ONLY_STEPS.includes(step),
  );
  if (unasserted.length > 0) {
    const skips = unasserted.filter((step) => skipped.includes(step));
    findings.push({
      code: 'X_FINISHED_GATE_PARTIAL',
      cause: `${floorFile} does not assert ${unasserted.join(', ')}${skips.length > 0 ? ` (skipped: ${skips.join(', ')})` : ''}, so ${app.dir} runs ${stepNames.length - FRAMEWORK_ONLY_STEPS.length - unasserted.length} of the ${stepNames.length - FRAMEWORK_ONLY_STEPS.length} steps an app can run`,
      fix: `edit ${floorFile}:1 — move ${unasserted.join(', ')} into "steps" once the app has what each skip's reason names, then: bun run scripts/reference-app-gate.ts --app ${dir}`,
      at: floorFile,
    });
  }
  if (app.floor['strict'] !== true) {
    findings.push({
      code: 'X_FINISHED_GATE_PARTIAL',
      cause: `${floorFile} is not "strict": true, so a step that skips itself passes ${app.dir}'s gate`,
      fix: `edit ${floorFile}:1 — set "strict": true, then: bun run scripts/reference-app-gate.ts --app ${dir}`,
      at: floorFile,
    });
  }
  return findings;
}

export function gateRow(apps: readonly GatedAppRead[], stepNames: readonly string[]): FinishedRow {
  if (apps.length === 0) {
    return red('gate-whole', 'GATED_APPS names no app', [
      {
        code: 'X_FINISHED_GATE_PARTIAL',
        cause: `${PINS_FILE} gates no app, so no tracked app proves the gate at all`,
        fix: `edit ${PINS_FILE}:1 — restore the GATED_APPS rows from git history`,
        at: PINS_FILE,
      },
    ]);
  }
  const findings = apps.flatMap((app) => appFindings(app, stepNames));
  const applicable = stepNames.length - FRAMEWORK_ONLY_STEPS.length;
  return findings.length === 0
    ? green(
        'gate-whole',
        `${apps.length} tracked apps assert ${applicable} of ${applicable} app steps, expectedRed empty`,
      )
    : red('gate-whole', `${findings.length} gap(s) in the tracked apps' gates`, findings);
}
