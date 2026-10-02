// Whether a set of CI parts — each `x verify --only <steps> [--shard i/n]` on its own runner — adds
// up to the gate's step list exactly once. The static half of what `x verify merge` checks after a
// run: this one fails before a push, the merge after. Pure; the caller reads the workflow.

export interface GatePart {
  readonly part: string;
  readonly only: readonly string[];
  /** `i/n`, as the matrix writes it. Absent on a part that runs its steps whole. */
  readonly shard?: string;
}

/** `2/3` → `{ index: 2, total: 3 }`; anything else is not a shard. */
export const shardOf = (raw: string): { index: number; total: number } | undefined => {
  const match = /^(\d+)\/(\d+)$/.exec(raw);
  if (match === null) return undefined;
  const index = Number(match[1]);
  const total = Number(match[2]);
  return index >= 1 && index <= total ? { index, total } : undefined;
};

/** The shards a set of `i/n` strings is missing or repeats, as sentences; empty when it is 1..n once. */
export const shardSetGaps = (label: string, shards: readonly string[]): readonly string[] => {
  const parsed = shards.map(shardOf);
  if (parsed.some((shard) => shard === undefined)) {
    return [`${label} carries a shard that is not i/n (${shards.join(', ')})`];
  }
  const known = parsed.filter((shard) => shard !== undefined);
  const totals = [...new Set(known.map((shard) => shard.total))];
  if (totals.length !== 1) return [`${label} mixes splits of ${totals.join(' and ')}`];
  const total = totals[0] ?? 0;
  const seen = known.map((shard) => shard.index);
  const missing = Array.from({ length: total }, (_, i) => i + 1).filter((i) => !seen.includes(i));
  const doubled = [...new Set(seen.filter((index, at) => seen.indexOf(index) !== at))];
  return [
    ...missing.map((index) => `${label} has no shard ${index}/${total}`),
    ...doubled.map((index) => `${label} has shard ${index}/${total} more than once`),
  ];
};

/**
 * Every way the parts fail to be the gate: a step no part runs, a step two parts run, a split
 * with a shard missing, a shard of a step that cannot be split, a name the gate does not have, and
 * two parts under one name — their artifacts would overwrite each other and one would vanish.
 */
export function partGaps(
  parts: readonly GatePart[],
  steps: readonly string[],
  shardable: readonly string[],
): readonly string[] {
  const gaps: string[] = [];
  const names = parts.map((part) => part.part);
  for (const name of new Set(names.filter((name, at) => names.indexOf(name) !== at))) {
    gaps.push(`two parts are named ${name}`);
  }
  for (const part of parts) {
    for (const step of part.only) {
      if (!steps.includes(step)) gaps.push(`${part.part} names ${step}, which is not a gate step`);
      else if (part.shard !== undefined && !shardable.includes(step)) {
        gaps.push(`${part.part} shards ${step}, which cannot be split`);
      }
    }
    if (part.only.length === 0) gaps.push(`${part.part} names no step`);
  }
  for (const step of steps) {
    const owners = parts.filter((part) => part.only.includes(step));
    const whole = owners.filter((part) => part.shard === undefined);
    const sharded = owners.filter((part) => part.shard !== undefined);
    if (owners.length === 0) gaps.push(`${step} is in no part`);
    else if (whole.length > 1 || (whole.length === 1 && sharded.length > 0)) {
      gaps.push(`${step} is in ${owners.length} parts (${owners.map((p) => p.part).join(', ')})`);
    } else if (sharded.length > 0) {
      gaps.push(
        ...shardSetGaps(
          step,
          sharded.map((part) => part.shard ?? ''),
        ),
      );
    }
  }
  return gaps;
}

/** Every `--flag` a shell line hands the script named `script`, and the word that follows its path. */
export function scriptCalls(
  run: string,
  script: string,
): readonly { readonly subcommand?: string; readonly flags: readonly string[] }[] {
  // Continuation lines are one command: the flags of a wrapped invocation are on the next line.
  const joined = run.replace(/\\\n/g, ' ');
  const calls: { subcommand?: string; flags: string[] }[] = [];
  for (const line of joined.split('\n')) {
    const at = line.indexOf(script);
    if (at === -1 || line.trimStart().startsWith('#')) continue;
    const tail = line.slice(at + script.length);
    const first = /^\s+([a-z][a-z-]*)\b/.exec(tail)?.[1];
    const flags = [...tail.matchAll(/--([a-z][a-z-]*)/g)].map((match) => match[1] ?? '');
    calls.push({ ...(first === undefined ? {} : { subcommand: first }), flags });
  }
  return calls;
}
