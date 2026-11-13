// What `x upgrade` says: the one report every outcome carries, the terminal's lines projected from it,
// and the sentence naming what to do next. No decisions and no I/O: `cmd-upgrade.ts` hands in the facts.

import { msg } from './messages';
import type { JsonValue } from './output';
import type { TypescriptLag } from './typescript-floor';
import type { AgentsLinkState } from './upgrade-agents-link';
import type { BunEdit, BunManual } from './upgrade-bun-floor';
import type { GateFinding, HopGate, RepoScript } from './upgrade-gate';
import type { UpgradeHop, UpgradePin } from './upgrade-plan';
import { pinMoves } from './upgrade-plan';

export interface PlannedWrites {
  /** Absolute path to final text; a manifest holding both a pin and a floor is written once. */
  readonly files: ReadonlyMap<string, string>;
  readonly edited: readonly BunEdit[];
  readonly manual: readonly BunManual[];
}

/** The strongest check a hop had: the verdict `done` rests on, stated rather than implied. */
export type HopProof = 'verify' | 'scripts' | 'none';

export const proofOf = (gate: HopGate | undefined, scripts: readonly RepoScript[]): HopProof =>
  gate !== undefined ? 'verify' : scripts.length > 0 ? 'scripts' : 'none';

/** What the agent does next, as a sentence naming the commands. */
export const thenLine = (input: {
  readonly hop: UpgradeHop;
  readonly dryRun: boolean;
  readonly app: boolean;
  readonly gate: HopGate | undefined;
  readonly scripts: readonly RepoScript[];
}): string => {
  const { hop, dryRun, app, gate, scripts } = input;
  if (hop.atTarget) {
    return hop.next === null
      ? msg('cli.upgrade.then.atLatest', { version: hop.to })
      : msg('cli.upgrade.then.atTarget', { version: hop.to, next: hop.next });
  }
  if (dryRun) {
    return app
      ? msg('cli.upgrade.then.dryRun')
      : msg('cli.upgrade.then.dryRunNoApp', {
          scripts: scripts.map((script) => `bun run ${script.name}`).join(', ') || 'nothing',
        });
  }
  if (!app) {
    if (scripts.length === 0) return msg('cli.upgrade.then.noProof', { to: hop.to });
    return scripts.every((script) => script.ok === true)
      ? msg('cli.upgrade.then.scriptsGreen', { to: hop.to })
      : msg('cli.upgrade.then.scriptsRed', { to: hop.to });
  }
  if (gate?.verify.ok !== true) return msg('cli.upgrade.then.red', { to: hop.to });
  return hop.next === null
    ? msg('cli.upgrade.then.last', { to: hop.to })
    : msg('cli.upgrade.then.walk', { to: hop.to, next: hop.next });
};

const findingLines = (findings: readonly GateFinding[]): readonly string[] =>
  findings.flatMap((finding) => [
    `  ${finding.code}${finding.step === undefined ? '' : ` [${finding.step}]`}${finding.at === undefined ? '' : ` (${finding.at})`}`,
    `    fix: ${finding.fix}`,
  ]);

/** The terminal's form of the report: the url first, then each finding's `fix:`. */
export const humanLines = (input: {
  readonly hop: UpgradeHop;
  readonly writes: PlannedWrites;
  readonly gate: HopGate | undefined;
  readonly scripts: readonly RepoScript[];
  readonly then: string;
  readonly agentsMd?: AgentsLinkState;
  /** Manifests whose TypeScript lags the scaffold's: by hand, the hop never moves a compiler. */
  readonly typescript: readonly TypescriptLag[];
}): readonly string[] => {
  const { hop, writes, gate, scripts, then, agentsMd, typescript } = input;
  return [
    ...(hop.section === null
      ? []
      : [msg('cli.upgrade.read', { title: hop.section.title, url: hop.section.url })]),
    ...writes.edited.map((edit) =>
      msg('cli.upgrade.bunEdited', { path: edit.path, from: edit.from, to: edit.to }),
    ),
    ...writes.manual.map((site) =>
      msg('cli.upgrade.bunManual', { path: site.path, line: site.line, why: site.why }),
    ),
    ...typescript.map((lag) => msg('cli.upgrade.typescript', { ...lag })),
    ...(agentsMd === 'link' || agentsMd === 'differs'
      ? [msg(agentsMd === 'link' ? 'cli.upgrade.agentsMd.link' : 'cli.upgrade.agentsMd.differs')]
      : []),
    ...(gate?.guards.installed ?? []).map((name) => msg('cli.upgrade.guardInstalled', { name })),
    ...(gate?.guards.withheld ?? []).map((guard) =>
      guard.findings === null
        ? msg('cli.upgrade.guardUnmeasured', { fix: guard.add })
        : msg('cli.upgrade.guardWithheld', { fix: guard.add, count: guard.findings }),
    ),
    ...(gate?.guards.differs ?? []).map((guard) =>
      msg('cli.upgrade.guard', { fix: guard.refresh }),
    ),
    ...(gate === undefined || gate.coverage === null
      ? []
      : [
          msg('cli.upgrade.coverage', {
            file: gate.coverage.file,
            fromLines: gate.coverage.from.lines,
            fromFuncs: gate.coverage.from.funcs,
            toLines: gate.coverage.to.lines,
            toFuncs: gate.coverage.to.funcs,
            lines: Math.floor(gate.coverage.measured.lines * 10) / 10,
            funcs: Math.floor(gate.coverage.measured.funcs * 10) / 10,
          }),
        ]),
    ...(gate === undefined || gate.exerciseFloor === null
      ? []
      : [
          msg('cli.upgrade.exerciseFloor', {
            file: gate.exerciseFloor.file,
            figures: JSON.stringify(gate.exerciseFloor.written),
          }),
        ]),
    // The exercise's own list first: every fix it has, before the gate's verdict on the same tree.
    ...findingLines([
      ...(gate?.exercise.findings ?? []),
      ...(gate?.manifest.findings ?? []),
      ...(gate?.verify.findings ?? []),
    ]),
    ...scripts
      .filter((script) => script.ok === false)
      .map((script) => msg('cli.upgrade.scriptRed', { name: script.name })),
    msg('cli.upgrade.then', { then }),
  ];
};

const asJson = (value: unknown): JsonValue => value as JsonValue;

/** The one shape every outcome reports: `--json` and the terminal project this and nothing else. */
export const report = (input: {
  readonly hop: UpgradeHop;
  readonly done: boolean;
  readonly dryRun: boolean;
  readonly pins: readonly UpgradePin[];
  readonly bunFrom: string | null;
  readonly bunTo: string | null;
  readonly writes: PlannedWrites;
  readonly app: boolean;
  readonly gate: HopGate | undefined;
  readonly scripts: readonly RepoScript[];
  readonly then: string;
  /** What the hop does to `AGENTS.md` (`upgrade-agents-link.ts`); absent when no hop is planned. */
  readonly agentsMd?: AgentsLinkState;
  /** `typescript-floor.ts`'s lags — reported on every outcome, an at-target app's included. */
  readonly typescript: readonly TypescriptLag[];
}): JsonValue => {
  const { hop, done, dryRun, pins, bunFrom, bunTo, writes, app, gate, scripts, then } = input;
  return asJson({
    from: hop.from,
    to: hop.to,
    next: hop.next,
    done,
    dryRun,
    app,
    proof: dryRun ? 'none' : proofOf(gate, scripts),
    section: hop.section,
    pins: hop.atTarget
      ? []
      : pins
          .filter((pin) => pinMoves(pin.spec, hop.to))
          .map((pin) => ({ file: pin.file, name: pin.name, from: pin.spec, to: hop.to })),
    bun: { from: bunFrom, to: bunTo, edited: writes.edited, manual: writes.manual },
    typescript: input.typescript,
    agentsMd: input.agentsMd ?? null,
    guards: gate?.guards ?? null,
    coverage: gate?.coverage ?? null,
    manifest: gate?.manifest ?? null,
    exercise: gate?.exercise ?? null,
    exerciseFloor: gate?.exerciseFloor ?? null,
    verify: gate?.verify ?? null,
    scripts,
    then,
  });
};

export const NO_WRITES: PlannedWrites = { files: new Map(), edited: [], manual: [] };
