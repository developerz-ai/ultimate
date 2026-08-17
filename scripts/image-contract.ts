#!/usr/bin/env bun
// Enforce, as a gate step, the two properties that make `docker/Dockerfile` produce an image that
// can start. It shipped one that could not: the build stage was `oven/bun:1.3-alpine`, so the
// compiled binary asked for `/lib/ld-musl-x86_64.so.1` on a glibc-only distroless runtime and EVERY
// container of EVERY build died with `exec /app/x: no such file or directory`. The build stayed
// green, because the one thing that would have caught it — `/out/app --version` — ran on the BUILD
// stage, which is not what ships. `docker build` runs on no PR, so nothing stops either recurring.
//
// TWO RULES, both derived entirely from the file, neither needing a table that can go stale:
//   libc     the stage the runtime COPYs its artifact from must link the same libc family the
//            runtime provides. `alpine` means musl and `slim`/`debian`/`distroless/cc` mean glibc
//            for as long as those distributions exist; an image neither pattern recognises yields
//            NO finding, because unknown is not broken.
//   guard    the final stage's ENTRYPOINT binary must be RUN inside that same stage. "There is a
//            guard" and "the guard runs on what ships" are different claims and only the second was
//            violated — the broken Dockerfile had a guard, one stage too early.
//
// What is deliberately NOT here: the Dockerfile's own claim that the runtime's Debian GENERATION
// must equal the build base's. It is true (glibc is backward but not forward compatible), and
// checking it needs a tag -> glibc-version table — `oven/bun:1.3-slim` is trixie and says so
// nowhere in its tag. That table is a hand-kept list that fails on a CORRECT Dockerfile the day
// oven/bun rebases, which is the defect class this whole file exists to close.
//
//   bun run scripts/image-contract.ts [--json]

import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

export const DOCKERFILE = 'docker/Dockerfile';

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
      const from = /^(\S+)(?:\s+[Aa][Ss]\s+(\S+))?/.exec(value);
      stages.push({
        base: from?.[1] ?? value,
        line: start,
        instructions: [],
        ...(from?.[2] === undefined ? {} : { name: from[2] }),
      });
      continue;
    }
    const stage = stages.at(-1);
    if (stage === undefined) continue;
    (stage.instructions as Instruction[]).push({ keyword, value, line: start });
  }
  return stages;
}

export type Libc = 'musl' | 'glibc';

/**
 * Which C library an image provides. Facts about distributions, not version pins: Alpine will not
 * stop being musl and Debian will not stop being glibc, so this table cannot rot the way a
 * tag -> glibc-version table would. Anything unrecognised answers `undefined`, and an unknown side
 * produces no finding — a checker that guessed here would fail on a correct Dockerfile.
 */
export function libcOf(image: string): Libc | undefined {
  if (/(?:^|[-:/@._])(?:alpine|musl)/i.test(image)) return 'musl';
  if (/distroless\/(?:cc|base)/i.test(image)) return 'glibc';
  if (/(?:^|[-:/@._])(?:slim|debian\d*|bookworm|trixie|bullseye|ubuntu|jammy|noble)/i.test(image)) {
    return 'glibc';
  }
  return undefined;
}

/** `RUN ["a","b"]` and `RUN a b` both answer `a`. Exec form is JSON, shell form is whitespace. */
export function argv0(value: string): string | undefined {
  const text = value.trim();
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      const head = Array.isArray(parsed) ? parsed[0] : undefined;
      return typeof head === 'string' ? head : undefined;
    } catch {
      // A malformed exec array is docker's error to report, not this rule's to guess at.
      return undefined;
    }
  }
  return text.split(/\s+/)[0];
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

export type ImageGapKind = 'libc' | 'guard';

export interface ImageGap {
  readonly kind: ImageGapKind;
  readonly line: number;
  /** For `libc`: the producing stage's image and family. For `guard`: the entrypoint binary. */
  readonly detail: string;
  readonly runtime: string;
}

/** Pure, so the negative case is a fixture rather than an edit to the Dockerfile that ships. */
export function checkImage(dockerfile: string): readonly ImageGap[] {
  const stages = parseDockerfile(dockerfile);
  const runtime = stages.at(-1);
  if (runtime === undefined) return [];
  const runtimeImage = baseImageOf(runtime, stages);
  const runtimeLibc = libcOf(runtimeImage);
  const gaps: ImageGap[] = [];

  for (const source of copySources(runtime)) {
    const producer = stages.find((one) => one.name?.toLowerCase() === source.toLowerCase());
    if (producer === undefined) continue;
    const image = baseImageOf(producer, stages);
    const libc = libcOf(image);
    if (libc === undefined || runtimeLibc === undefined || libc === runtimeLibc) continue;
    gaps.push({
      kind: 'libc',
      line: producer.line,
      detail: `${source} on ${image} (${libc})`,
      runtime: `${runtimeImage} (${runtimeLibc})`,
    });
  }

  const entrypoint = runtime.instructions.filter((one) => one.keyword === 'ENTRYPOINT').at(-1);
  const binary = entrypoint === undefined ? undefined : argv0(entrypoint.value);
  if (binary !== undefined) {
    const runs = runtime.instructions
      .filter((one) => one.keyword === 'RUN')
      .map((one) => argv0(one.value));
    if (!runs.includes(binary)) {
      gaps.push({
        kind: 'guard',
        line: entrypoint?.line ?? runtime.line,
        detail: binary,
        runtime: runtimeImage,
      });
    }
  }
  return gaps;
}

const where = (gap: ImageGap): string => `${DOCKERFILE}:${gap.line}`;

const libcFinding = (gap: ImageGap): Finding => ({
  code: 'X_IMAGE_LIBC_MISMATCH',
  cause: `${DOCKERFILE} builds its artifact in stage ${gap.detail} and ships it on ${gap.runtime}, so the binary asks for a loader the runtime does not have — every container exits "exec: no such file or directory" and the build stays green`,
  fix: `change that stage's FROM to a base of the same libc family as the runtime in ${DOCKERFILE}, then docker build -f ${DOCKERFILE} -t ultimate-app:libc-check .`,
  at: where(gap),
});

const guardFinding = (gap: ImageGap): Finding => ({
  code: 'X_IMAGE_GUARD_MISSING',
  cause: `the final stage of ${DOCKERFILE} ships ${gap.detail} as its ENTRYPOINT and never runs it, so a binary that cannot exec passes the build and fails on the first command an operator runs — a guard in an earlier stage proves the build image, which is not what ships`,
  fix: `add \`RUN ["${gap.detail}", "--version"]\` to the FINAL stage of ${DOCKERFILE} (exec form — a distroless stage has no shell), then docker build -f ${DOCKERFILE} -t ultimate-app:guard-check .`,
  at: where(gap),
});

const FINDINGS: Readonly<Record<ImageGapKind, (gap: ImageGap) => Finding>> = {
  libc: libcFinding,
  guard: guardFinding,
};

export const imageGapFindingFor = (gap: ImageGap): Finding => FINDINGS[gap.kind](gap);

/**
 * Read the Dockerfile, then check it. The one impure step. A root with no Dockerfile is not this
 * check's problem — the host checks run against synthetic trees in `scripts/verify.test.ts`.
 */
export async function imageGaps(root: string): Promise<readonly ImageGap[]> {
  const file = Bun.file(`${root}/${DOCKERFILE}`);
  if (!(await file.exists())) return [];
  return checkImage(await file.text());
}

/** What this repo contributes to `x verify`'s `boundaries` step. */
export const imageContractFindings = async (root: string): Promise<readonly Finding[]> =>
  (await imageGaps(root)).map(imageGapFindingFor);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const gaps = await imageGaps(root);
  const stages = parseDockerfile(await Bun.file(`${root}/${DOCKERFILE}`).text());
  report(
    {
      ok: gaps.length === 0,
      script: 'image-contract',
      summary:
        gaps.length === 0
          ? `${stages.length} stages in ${DOCKERFILE}: one libc family, and the shipped entrypoint proven in the stage that ships it`
          : `${gaps.length} image-contract violation(s) in ${DOCKERFILE}`,
      findings: gaps.map(imageGapFindingFor),
    },
    args.json,
  );
}
