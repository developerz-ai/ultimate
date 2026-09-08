// `.x/shot/island/index.md` — the one file an agent opens after a capture, instead of guessing at
// forty PNGs. A PURE renderer over (manifests, targets, verdicts): no disk, no browser, no server,
// so every rule about what the index must carry is a unit test. The caller does the writing.

import type { IslandShotTarget, IslandState, IslandStatesManifest } from '@ultimat3/testing';
import type { IslandStateShot, IslandVerdict } from './island-verdict';

/** Markdown, because the reader is a coding agent: it greps, and it renders in a review. */
export const ISLAND_INDEX = 'index.md';

export interface IslandIndexPair {
  readonly manifest: IslandStatesManifest;
  readonly verdict: IslandVerdict;
}

export interface IslandIndexInput {
  readonly pairs: readonly IslandIndexPair[];
  readonly capturedAt: string;
  /**
   * What the capture could not see, ALREADY rendered — `IslandVerdict.blind`, handed in rather
   * than re-derived here. A blind-spot list this module worded itself would be a second answer to
   * the question the verdict already publishes, and the two would drift the first time one moved.
   */
  readonly blind: readonly string[];
}

/** The pictures one state was owed, in declaration order, whatever landed on disk. */
const targetsOf = (verdict: IslandVerdict, state: string): readonly IslandShotTarget[] =>
  verdict.expected.filter((target) => target.state === state);

const shotsOf = (verdict: IslandVerdict, state: string): readonly IslandStateShot[] =>
  verdict.shots.filter((shot) => shot.state === state);

const countOf = (
  level: IslandStateShot['console'][number]['level'],
  shot: IslandStateShot,
): number => shot.console.filter((line) => line.level === level).length;

const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? '' : 's'}`;

/**
 * What went wrong with this state, in the reader's own terms — never a code. Each clause is a
 * different repair, so they are listed rather than collapsed into "failed".
 */
function problemsOf(verdict: IslandVerdict, state: string): readonly string[] {
  const problems: string[] = [];
  const taken = new Set(shotsOf(verdict, state).map((shot) => shot.file));
  for (const target of targetsOf(verdict, state)) {
    if (!taken.has(target.file)) problems.push(`no picture (${target.theme})`);
  }
  for (const shot of shotsOf(verdict, state)) {
    if (!shot.mounted) problems.push(`never mounted (${shot.theme})`);
    if (shot.unstubbed.length > 0) {
      problems.push(`${plural(shot.unstubbed.length, 'request')} no stub answers`);
    }
    if (shot.pageErrors.length > 0) {
      problems.push(plural(shot.pageErrors.length, 'uncaught exception'));
    }
    const errors = countOf('error', shot);
    if (errors > 0) problems.push(plural(errors, 'console error'));
  }
  return [...new Set(problems)];
}

/**
 * Recorded and NOT gating, which is the whole reason it is a separate line: a warning that fails a
 * run is a warning an author switches off, and an overflowing box is a fact a PNG often cannot
 * show at all. `stateShotOk` reads neither.
 */
function notesOf(verdict: IslandVerdict, state: string): readonly string[] {
  const shots = shotsOf(verdict, state);
  const warnings = shots.reduce((total, shot) => total + countOf('warn', shot), 0);
  const notes: string[] = [];
  if (warnings > 0) notes.push(plural(warnings, 'console warning'));
  const overflows = shots.filter((shot) => shot.overflow.x || shot.overflow.y);
  for (const shot of overflows) {
    const axes = [shot.overflow.x ? 'horizontally' : '', shot.overflow.y ? 'vertically' : '']
      .filter((axis) => axis !== '')
      .join(' and ');
    notes.push(`content overflows the crop target ${axes} (${shot.theme})`);
  }
  return notes;
}

const stateSection = (
  manifest: IslandStatesManifest,
  verdict: IslandVerdict,
  state: IslandState,
): readonly string[] => {
  const problems = problemsOf(verdict, state.id);
  const notes = notesOf(verdict, state.id);
  const lines = [`### \`${state.id}\` — ${state.title}`, ''];
  // The note is why a reviewer knows what they are looking at: a state a running app will not
  // produce on request has no other explanation anywhere in the artifact.
  if (state.note !== undefined) lines.push(state.note, '');
  for (const target of targetsOf(verdict, state.id)) {
    lines.push(`- ${target.theme}: \`${target.file}\``);
  }
  lines.push(
    `- verdict: ${problems.length === 0 ? 'ok' : `FAILED — ${problems.join('; ')}`}`,
    ...notes.map((note) => `- note: ${note}`),
    '',
    `- re-run: \`x shot --island ${manifest.name} --state ${state.id} --json\``,
    '',
  );
  return lines;
};

const islandSection = (pair: IslandIndexPair): readonly string[] => {
  const photographed = new Set(pair.verdict.expected.map((target) => target.state));
  return [
    `## ${pair.manifest.name} — ${pair.verdict.ok ? 'ok' : 'FAILED'}`,
    '',
    `source: \`${pair.manifest.island}\``,
    '',
    ...pair.manifest.states
      .filter((state) => photographed.has(state.id))
      .flatMap((state) => stateSection(pair.manifest, pair.verdict, state)),
  ];
};

/**
 * The whole index. The header states the three counts a reader needs before scrolling — how many
 * islands, how many states, how many pictures — and the command that reproduces the run, because
 * an artifact that cannot be regenerated is one nobody trusts a second time.
 */
export function renderIslandIndex(input: IslandIndexInput): string {
  const states = input.pairs.reduce(
    (total, pair) => total + new Set(pair.verdict.expected.map((one) => one.state)).size,
    0,
  );
  const pictures = input.pairs.reduce((total, pair) => total + pair.verdict.expected.length, 0);
  const failed = input.pairs.filter((pair) => !pair.verdict.ok).map((pair) => pair.manifest.name);
  const lines = [
    `# island states — ${plural(input.pairs.length, 'island')}, ${plural(states, 'state')}, ${plural(pictures, 'picture')}`,
    '',
    `Captured ${input.capturedAt}. Every picture is the component's own box, from a real browser,`,
    'in a state a running app will not produce on request.',
    '',
    failed.length === 0
      ? 'Every state photographed cleanly.'
      : `FAILED: ${failed.join(', ')} — each one names its reason below.`,
    '',
    'Re-run everything: `x shot --all-islands --json`',
    'Re-run one island: `x shot --island <name> --json`',
    'Re-run one state:  `x shot --island <name> --state <id> --json`',
    '',
    'What this capture cannot see:',
    '',
    ...input.blind.map((blind) => `- ${blind}`),
    '',
    ...input.pairs.flatMap(islandSection),
  ];
  return `${lines.join('\n').trimEnd()}\n`;
}
