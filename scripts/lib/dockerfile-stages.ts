// A Dockerfile read as stages, and the walk from one stage to every place its artifacts were
// linked — the half of `image-contract`'s libc rule that is about Dockerfile structure, not libc.
// Pure over the text, so every case is a fixture string.

export interface Instruction {
  readonly keyword: string;
  readonly value: string;
  /** 1-based, so `docker/Dockerfile:92` opens it. */
  readonly line: number;
}

export interface Stage {
  readonly base: string;
  readonly name?: string;
  readonly line: number;
  readonly instructions: readonly Instruction[];
}

/**
 * Stages, with continuations joined and comments dropped. A `RUN` that spans five lines is one
 * instruction — reading the file line by line would see its tail as five unknown keywords.
 */
export function parseDockerfile(text: string): readonly Stage[] {
  const stages: Stage[] = [];
  const lines = text.split('\n');
  let buffer = '';
  let start = 0;
  for (const [index, raw] of lines.entries()) {
    const line = raw ?? '';
    if (buffer === '' && /^\s*(?:#|$)/.test(line)) continue;
    if (buffer === '') start = index + 1;
    buffer += line.replace(/\\\s*$/, ' ');
    if (/\\\s*$/.test(line)) continue;
    const match = /^\s*([A-Za-z]+)\s+(.*)$/.exec(buffer);
    buffer = '';
    if (match === null) continue;
    const keyword = (match[1] ?? '').toUpperCase();
    const value = (match[2] ?? '').trim();
    if (keyword === 'FROM') {
      // `FROM --platform=$BUILDPLATFORM oven/bun:1.3-alpine AS build` — the flags come FIRST, and
      // reading `--platform=…` as the base image made `libcOf` answer `undefined`, which this file
      // treats as "unknown, say nothing". A cross-build Dockerfile would therefore have skipped the
      // libc rule entirely: the one syntax most likely to pair two architectures, silently exempt.
      const from = /^((?:--\S+\s+)*)(\S+)(?:\s+[Aa][Ss]\s+(\S+))?/.exec(value);
      stages.push({
        base: from?.[2] ?? value,
        line: start,
        instructions: [],
        ...(from?.[3] === undefined ? {} : { name: from[3] }),
      });
      continue;
    }
    const stage = stages.at(-1);
    if (stage === undefined) continue;
    (stage.instructions as Instruction[]).push({ keyword, value, line: start });
  }
  return stages;
}

/** `COPY --from=build /out/app /app/x` -> `build`. */
export const copySources = (stage: Stage): readonly string[] =>
  stage.instructions
    .filter((one) => one.keyword === 'COPY')
    .flatMap((one) => [...one.value.matchAll(/--from=(\S+)/g)].map((match) => match[1] ?? ''));

/** A stage may build `FROM` another stage; follow it to the image that actually supplies the libc. */
export function baseImageOf(stage: Stage, stages: readonly Stage[]): string {
  let current = stage;
  for (let hop = 0; hop < stages.length; hop += 1) {
    const next = stages.find((one) => one.name?.toLowerCase() === current.base.toLowerCase());
    if (next === undefined) return current.base;
    current = next;
  }
  return current.base;
}

/** `--from=<source>` as a stage: by name, or by INDEX (`--from=0` is the first `FROM`). */
function stageNamed(source: string, stages: readonly Stage[]): Stage | undefined {
  const named = stages.find((one) => one.name?.toLowerCase() === source.toLowerCase());
  return named ?? (/^\d+$/.test(source) ? stages[Number(source)] : undefined);
}

/** A stage and every stage it is built `FROM` — files any of them copied in are in it. */
function lineage(stage: Stage, stages: readonly Stage[]): readonly Stage[] {
  const chain = [stage];
  for (let next = stageNamed(stage.base, stages); next !== undefined && !chain.includes(next); ) {
    chain.push(next);
    next = stageNamed(next.base, stages);
  }
  return chain;
}

export interface Producer {
  readonly source: string;
  readonly image: string;
  readonly line?: number;
}

/**
 * Every place an artifact in `stage` may have been linked: each `COPY --from=<source>` of the
 * stage and of its `FROM` ancestors, and — RECURSIVELY — each one of the stages those copy from.
 * A binary built on alpine, copied into a debian `assemble` stage and from there onto a glibc
 * runtime still asks for musl's loader; reading only the final stage's own sources saw `assemble`.
 * A source that is no stage is an image reference, whose libc is its own, exactly as a stage's.
 */
export function producersOf(stage: Stage, stages: readonly Stage[]): readonly Producer[] {
  const found: Producer[] = [];
  const seen = new Set<Stage>(lineage(stage, stages));
  const queue = [...seen];
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    for (const source of copySources(current)) {
      const producer = stageNamed(source, stages);
      if (producer === undefined) {
        // An image has no line of its own: the stage that copies from it is the edit.
        found.push({ source, image: source, line: current.line });
        continue;
      }
      if (seen.has(producer)) continue;
      seen.add(producer);
      found.push({ source, image: baseImageOf(producer, stages), line: producer.line });
      queue.push(producer);
      for (const ancestor of lineage(producer, stages)) {
        if (seen.has(ancestor)) continue;
        seen.add(ancestor);
        queue.push(ancestor);
      }
    }
  }
  return found;
}
